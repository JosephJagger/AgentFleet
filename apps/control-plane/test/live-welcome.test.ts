import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveWelcomeGate,LIVE_WELCOME_TEXT} from '../src/live-welcome.js';
const entry=(now:number,patch:Record<string,unknown>={})=>({kind:'enter',source:'douyin-barrage-grab:直播伴侣',confirmedOwnRoom:true,audioIdle:true,roomId:'room',ownerId:'owner',eventId:'entry',viewerId:'viewer',requestId:'request',observedAt:now,...patch});
test('welcome accepts only explicit recent member events from a confirmed room; busy work wins',()=>{
 const gate=new LiveWelcomeGate();gate.quietAt=0;const now=10000;
 for(const patch of [{kind:'chat'},{source:'chrome'},{confirmedOwnRoom:false},{audioIdle:false},{eventId:''},{observedAt:now-21000},{observedAt:now+1}])assert.equal(gate.accept(entry(now,patch),false,now),false);
 assert.equal(gate.accept(entry(now),true,now),false);
 assert.equal(gate.accept(entry(now),false,now),true);
 assert.ok(LIVE_WELCOME_TEXT.includes('嗨，你好，欢迎光临'));assert.ok(!LIVE_WELCOME_TEXT.includes('viewerId'));
});
test('unknown delivery is reserved once, repeat visitors and floods cannot create repeated greetings',()=>{
 const gate=new LiveWelcomeGate();gate.quietAt=0;
 assert.equal(gate.accept(entry(10000),false,10000),true);
 assert.equal(gate.accept(entry(41000),false,41000),false);
 assert.equal(gate.accept(entry(41000,{eventId:'again'}),false,41000),false);
 assert.equal(gate.accept(entry(20000,{eventId:'other',viewerId:'other'}),false,20000),false);
 assert.equal(gate.accept(entry(41000,{eventId:'other',viewerId:'other'}),false,41000),true);
 assert.equal(gate.accept(entry(610001,{eventId:'reenter'}),false,610001),true);
});
test('user transcript/tool activity imposes a fresh quiet window',()=>{
 const gate=new LiveWelcomeGate();gate.touch(10000);
 assert.equal(gate.accept(entry(14000),false,14000),false);
 assert.equal(gate.accept(entry(15000),false,15000),true);
});

test('an in-flight voice tool prevents greetings even after its initial quiet window',()=>{
 const gate=new LiveWelcomeGate();gate.quietAt=0;gate.beginWork();gate.beginWork();
 assert.equal(gate.accept(entry(60000),false,60000),false);
 gate.endWork();gate.quietAt=0;assert.equal(gate.accept(entry(60000),false,60000),false);
 gate.endWork();gate.quietAt=0;assert.equal(gate.accept(entry(60000),false,60000),true);
});
