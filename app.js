#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const updateNotifier = require('update-notifier');
const { ScreepsAPI } = require('screeps-api')
const request = require('request')
const editor = require('editor')
const pkg = require('./package.json');
let api = new ScreepsAPI()
let setupRan = false

if(process.argv[2] == 'test') process.exit(0) // Placeholder ;)

let {file,config} = loadConfig()
if(config)
  start()
else
  setup()


function start(){
  if(config.sampleConfig || !config.screeps || !config.service){
    console.log(file,"doe not have a valid config")
    return setup()
  }
  if(config.checkForUpdates)
    updateNotifier({pkg}).notify();
  api.auth(config.screeps.username,config.screeps.password).then((res)=>{
   // console.log('Authenticated')
   // console.log('Using stats method',config.screeps.method)
    if(config.screeps.method == 'console')
      beginConsoleStats()
    else
      beginMemoryStats()
  })
}

function beginConsoleStats(){
  api.socket.connect()
  api.socket.on('connected',()=>{
    api.socket.subscribe('console')    
  })
  api.socket.on('console',(event)=>{
    console.log(event)
    if(event.data.messages && event.data.messages.log)
      event.data.messages.log
        .filter(l=>l.startsWith('STATS'))
        .forEach(log=>processStats(log))
  })
}

function formatStats(data){
  if (data[0] === '{') data = JSON.parse(data)
  if(typeof data == 'object')
    return { 
      type: 'application/json',
      stats: data
    }
  let [header,type,tick,time,...stats] = data.split(";")
  if(type.startsWith('text')){
    stats = stats.map(s=>`${s} ${time}`).join("\n") + "\n"
  }
  return Promise.resolve({ header,type,tick,time,stats })
}

function beginMemoryStats(){
  tick()
  setInterval(tick,15000)
}
function addProfileData(stats){
    return api.me().then(res=>{
      let credits = res.money || 0
      let power = res.power || 0
      if(stats.type == 'application/json'){
        stats.stats.credits = credits
        stats.stats.power = power
      }
      if(stats.type == 'text/grafana'){
        stats.stats += `credits ${credits} ${Date.now()}\n`
        stats.stats += `power ${power} ${Date.now()}\n`
      }
      if(stats.type == 'text/influxdb')
        stats.stats += `profile,user=${api.user.username} credits=${credits},power=${power} ${Date.now()}\n`
      return stats
    });
}
function addLeaderboardData(stats){
    let leaderboardUrl = `/api/leaderboard/find?mode=world&username=${api.user.username}`;
    return api.leaderboard.find(api.user.username,'world').then(res=>{
      let { rank, score } = res.list.slice(-1)[0];
      if(stats.type == 'application/json'){
        stats.stats.leaderboard = { rank, score }
      }
      if(stats.type == 'text/grafana'){
        stats.stats += `leaderboard.rank ${rank} ${Date.now()}\n`
        stats.stats += `leaderboard.score ${score} ${Date.now()}\n`
      }
      if(stats.type == 'text/influxdb')
        stats.stats += `leaderboard,user=${api.user.username} rank=${rank},score=${score} ${Date.now()}\n`
      return stats
    });
}
 
function tick(){
  Promise.resolve()
    //.then(()=>console.log('Fetching Stats'))
    .then(getStats)
    .then(processStats)
    .catch(err=>console.error(err))
}

function processStats(data){
  return Promise.resolve(data)
    .then(formatStats)
    .then(addProfileData)
    .then(addLeaderboardData)
    .then(pushStats)
}

function getStats(){
    if(config.screeps.segment) {
        return api.memory.segment.get(config.screeps.segment, config.screeps.shard || 'shard0').then(r => r.data)
    } else {
        return api.memory.get('stats', config.screeps.shard || 'shard0').then(r => r.data)
    }
}

function pushStats(data){
  let {type,stats} = data
  if(!stats) return console.log('No stats found, is Memory.stats defined?')
  if(config.showRawStats) console.log('Stats:',JSON.stringify(stats,null,3))
 // console.log('Pushing stats')
  let sconfig = config.service
  if(type == 'application/json') stats = JSON.stringify(stats)
  request({
    method: 'POST',
    url: sconfig.url + '/api/stats/submit',
    auth: {
      user: 'token',
      pass: sconfig.token
    },
    headers:{
      'content-type':type
    },
    body: stats
  },(err,res,data)=>{
    if(res && res.statusCode == 413){
      let len = Math.round(JSON.stringify(stats).length/1024)
      console.log(`stats size: ${len}kb`)
      console.log(`stats limit: 10mb (As of Mar 28, 2017) (If you hit this limit, you are probably doing something wrong)`)
      console.error(`It appears your stats data is too large, please check to make sure you are not submitting unneeded stats, such as old rooms. \n If you legitimately need to submit stats this large, contact ags131 on slack for a limit bump`)
    }
    //console.log('Result:',data)
    if(err) console.error(err)
  })
}

function setup(){
  if(setupRan){
    console.log('Agent not configured. Did you forget to edit the config?')
    process.exit()
  }
  setupRan = true
  let path = getConfigPaths().create
  if(path){
    fs.writeFileSync(path,fs.readFileSync(__dirname + '/config.js.sample'))
    editor(path,(code)=>{
      if(!code) start()
    })
  }else{
    console.log('Please setup config.js before running.')
    console.log(`Valid paths for your platform (${process.platform}):`)
    getConfigPaths().paths.forEach(path=>console.log(`- ${path}`))
    console.log()
    console.log('Or set the AGENT_CONFIG_PATH environment variable to point to a valid config file.')
  }
}

function getConfigPaths(){
  let appname = 'screepsplus-agent'
  let paths = []
  if(process.env.AGENT_CONFIG_PATH)
    paths.push(process.env.AGENT_CONFIG_PATH)
  paths.push(path.join(__dirname,'config.js'))
  let create = ''
  if(process.platform == 'linux'){
    create = `${process.env.HOME}/.${appname}`
    paths.push(create)
    paths.push(`/etc/${appname}/config.js`)
  }
  if(process.platform == 'win32'){
    let dir = path.join(process.env.APPDATA,appname)
    try{ fs.mkdirSync(dir) }catch(e){}
    if(!fs.existsSync(path.join(dir,'config.js'))){
      fs.writeFileSync(path.join(dir,'config.js'),fs.readFileSync(path.join(__dirname,'config.js.sample')))
    }
    paths.push(path.join(dir,'config.js'))
  }
  create = ''
  return { paths, create }
}

function loadConfig(){
  let {paths} = getConfigPaths()
  for(let i in paths){
    let file = paths[i]
    try{
      // console.log('Try',file)
      let config = require(file)
     // console.log(file)
      return { config, file }
    }catch(e){}
  }
  return false
}
