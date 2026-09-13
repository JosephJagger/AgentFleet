async (page) => {
  // Run only against the local preview; every API response below is fictional.
  await page.unroute("**/api/**");
  await page.evaluate(() => localStorage.setItem('agentfleet.locale','zh-CN'));
  const now = new Date().toISOString();
  const machines = ['开发主机 · Linux', 'Mac Studio', '构建节点 · Tokyo'].map((name,i)=>({machineId:`m${i}`,name,hostname:`host-${i}`,platform:i===1?'macOS':'Linux',platformRelease:i===1?'15.6':'24.04',architecture:i===1?'arm64':'x64',identityState:'active',securityState:'normal',reachability:'online',capacity:i===1?'idle':'busy',compatibility:'compatible',agentVersion:'0.28.0',codexVersion:'0.153.4',lastHeartbeatAt:now,credentialProtectionLevel:'software_protected',discovery:{state:'ready',readiness:'ready',discoveredProjects:2,discoveredSessions:8,scannedCount:8,scannedPages:1,lastSuccessfulAt:now}}));
  const projects = ['AgentFleet','Design System','Mobile Client','Build Pipeline'].map((alias,i)=>({projectId:`p${i}`,machineId:`m${i%3}`,alias,canonicalRoot:`/workspace/${alias.toLowerCase().replaceAll(' ','-')}`,branch:'main',leaseVersion:1,syncContent:true,retentionDays:7}));
  const titles=['升级控制台视觉与快捷导航','排队任务稳定性回归','组件库与交互细节','性能分析与构建优化','原生会话管理','移动端适配检查'];
  const sessions=titles.map((title,i)=>({logicalSessionId:`s${i}`,machineId:projects[i%4].machineId,projectId:`p${i%4}`,projectAlias:projects[i%4].alias,executionSegmentId:`seg${i}`,nativeThreadId:`native${i}`,title,managed:i<4,executionState:i===0||i===3?'running':'idle',reachability:'live',historyMode:'legacy',historyCompleteness:'complete',threadControlVersion:1,turnControlVersion:1,projectLeaseVersion:1,controlLeaseVersion:0,queueVersion:0,contentEpoch:1,projectionEpoch:1,latestSessionSeq:2,updatedAt:now,activeTurnId:i===0||i===3?`turn${i}`:null}));
  await page.route('**/api/**', async route=>{
    const [path,query='']=route.request().url().replace(/^https?:\/\/[^/]+/,'').split('?');
    const params=Object.fromEntries(query.split('&').map(pair=>pair.split('=').map(decodeURIComponent)));
    const url={searchParams:{has:key=>key in params,get:key=>params[key]}}; let result={};
    if(path==='/api/world-weather')result={updatedAt:now,cities:Object.fromEntries(['new-york','los-angeles','toronto','tokyo','beijing','berlin','paris','london','sydney'].map(id=>[id,[{date:now.slice(0,10),min:16,max:27,code:1},{date:new Date(Date.now()+86400000).toISOString().slice(0,10),min:18,max:28,code:0}]]))};
    else if(path==='/api/auth/status')result={authenticated:true,user:{userId:'demo',email:'operator@agentfleet.test'},clientSessionId:'browser'};
    else if(path==='/api/dashboard')result={machines,activitySessions:sessions.filter(s=>s.managed),counts:{onlineMachines:3,activeSessions:2,pendingApprovals:0},compatibilityProfile:{managedCodexVersion:'0.153.4',minimumCodexVersion:'0.153.2',validationStatus:'verified',profileVersion:'v1',schemaHash:'abc123',lastValidatedAt:now}};
    else if(path==='/api/projects')result={items:projects.filter(p=>!url.searchParams.has('machineId')||p.machineId===url.searchParams.get('machineId')),nextCursor:null};
    else if(path==='/api/sessions')result={items:sessions.filter(s=>(!url.searchParams.has('projectId')||s.projectId===url.searchParams.get('projectId'))&&(!url.searchParams.has('machineId')||s.machineId===url.searchParams.get('machineId'))),nextCursor:null};
    else if(/^\/api\/sessions\/s\d+$/.test(path))result={session:sessions.find(s=>s.logicalSessionId===path.split('/').at(-1)),commands:[],queue:[]};
    else if(path.endsWith('/events'))result={items:[{eventId:'ev-1',type:'item.completed',sessionSeq:1,occurredAt:now,payload:{item:{type:'userMessage',content:[{type:'text',text:'优化文字与移动端体验，让我们在手机上也能舒服地继续工作。'}]}}},{eventId:'ev-2',type:'item.completed',sessionSeq:2,occurredAt:now,payload:{item:{type:'agentMessage',text:'## 工作台设计预览\n\n主机、项目与会话清晰分层，手机上也能继续原来的工作。\n\n> 这是模拟会话，主机、天气与消耗均为虚构演示数据。\n\n```typescript\nconst workspace = "AgentFleets";\nconsole.log(workspace);\n```\n\n**已完成：** 主题切换、消息排版与移动端适配。'}}}],nextBeforeSeq:null,projectionEpoch:1,contentEpoch:1};
    else if(path==='/api/approvals')result={approvals:[]};
    else if(path==='/api/auth/sessions')result={clientSessions:[{clientSessionId:'browser',isCurrent:true,createdAt:now,lastSeenAt:now}]};
    else if(path.endsWith('/permissions'))result={profile:'project',source:'default',supported:true,preferences:{machine:{profile:null,revision:0},project:{profile:null,revision:0},session:{profile:null,revision:0}}};
    else if(path.endsWith('/codex-settings'))result={source:'machine',desired:{model:'gpt-6-astra',effort:'low'},preferences:{machine:{settings:{model:'gpt-6-astra',effort:'low'},revision:1},project:{settings:null,revision:0},session:{settings:null,revision:0}},catalog:{models:[{model:'gpt-6-astra',displayName:'gpt-6-astra',efforts:['low','high'],defaultEffort:'low'}],modes:[],fetchedAt:now}};
    else if(path.endsWith('/usage'))result={scope:path.includes('/machines/')?'machine':path.includes('/projects/')?'project':'session',recorded:{inputTokens:8200,outputTokens:4200,cachedInputTokens:0,reasoningOutputTokens:0,totalTokens:12400},quotaCycle:{startsAt:now,resetsAt:now,recordedTokens:8200,boundaryIncomplete:false},observedSessions:1,totalSessions:1,coverage:'observed-only',accounts:[],topSessions:[],topProjects:[],topWeeklySessions:[],topWeeklyProjects:[],last:null,nativeTotal:null,modelContextWindow:null,discontinuities:0};
    else if(path.endsWith('/operations'))result={operations:[]};
    else if(path==='/api/runtime-release')result={configured:true,paused:false,workerOnline:true,phase:'idle',message:'当前版本已完成验证',target:{version:'0.153.4'},latestVersion:'0.153.4',checks:[],history:[]};
    else if(path==='/api/release')result={controlPlaneBuild:'cyber-preview',dbSchemaVersion:24,agentVersion:'0.28.0'};
    else if(path==='/api/auth/ws-ticket')result={ticket:'preview'};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.routeWebSocket('**/ws/**',ws=>ws.onMessage(()=>{}));
  await page.goto('http://127.0.0.1:22344/sessions/s2');
  await page.getByRole('button',{name:'会话配置',exact:true}).waitFor();

}
