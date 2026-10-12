import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveWelcomeGate,LIVE_WELCOME_TEXT} from '../src/live-welcome.js';
const entry=(now:number,patch:Record<string,unknown>={})=>({kind:'enter',source:'home-douyin-collector:companion-log',streamEnabled:true,nativeMethod:'WebcastMemberMessage',entryAction:'1',sourceObservedAt:now,nativeInterruptible:true,roomId:'room',eventId:'entry',viewerId:'viewer',requestId:'request',observedAt:now,...patch});
test('welcome accepts only explicit recent member events from the new local collector; busy work wins',()=>{
 const gate=new LiveWelcomeGate();const now=10000;
 for(const patch of [{kind:'chat'},{source:'chrome'},{streamEnabled:false},{entryAction:'2'},{nativeMethod:'WebcastChatMessage'},{sourceObservedAt:now-21000},{sourceObservedAt:now+5001},{nativeInterruptible:false},{eventId:''},{observedAt:now-21000},{observedAt:now+5001}])assert.equal(gate.accept(entry(now,patch),false,now),false);
 assert.equal(gate.accept(entry(now),true,now),false);
 assert.equal(gate.accept(entry(now),false,now),true);
 assert.ok(LIVE_WELCOME_TEXT.includes('嗨，你好，欢迎光临'));assert.ok(!LIVE_WELCOME_TEXT.includes('viewerId'));
});
test('unknown delivery is reserved once, repeat visitors and floods cannot create repeated greetings',()=>{
 const gate=new LiveWelcomeGate();
 assert.equal(gate.accept(entry(10000),false,10000),true);
 assert.equal(gate.accept(entry(41000),false,41000),false);
 assert.equal(gate.accept(entry(41000,{eventId:'again'}),false,41000),false);
 assert.equal(gate.accept(entry(20000,{eventId:'other',viewerId:'other'}),false,20000),false);
 assert.equal(gate.accept(entry(41000,{eventId:'other',viewerId:'other'}),false,41000),true);
 assert.equal(gate.accept(entry(610001,{eventId:'reenter'}),false,610001),true);
});
test('transcript activity does not require fabricated audio-idle evidence',()=>{
 const gate=new LiveWelcomeGate();
 assert.equal(gate.accept(entry(14000),false,14000),true);
});

test('an in-flight voice tool prevents greetings until all work finishes',()=>{
 const gate=new LiveWelcomeGate();gate.beginWork();gate.beginWork();
 assert.equal(gate.accept(entry(60000),false,60000),false);
 gate.endWork();assert.equal(gate.accept(entry(60000),false,60000),false);
 gate.endWork();assert.equal(gate.accept(entry(60000),false,60000),true);
});

test('small browser clock skew is tolerated; rejections expose exact reasons',()=>{
 const gate=new LiveWelcomeGate();const now=10000;
 assert.equal(gate.accept(entry(now,{observedAt:now+5000,sourceObservedAt:now+5000}),false,now),true);
 assert.equal(gate.accept(entry(now),false,now),false);assert.equal(gate.rejectionReason,'duplicate_event');
 const fresh=new LiveWelcomeGate();
 assert.equal(fresh.accept(entry(now,{observedAt:now+5001}),false,now),false);assert.equal(fresh.rejectionReason,'event_time');
 assert.equal(fresh.accept(entry(now,{sourceObservedAt:now-20001}),false,now),false);assert.equal(fresh.rejectionReason,'event_time');
 assert.equal(fresh.accept(entry(now,{nativeInterruptible:false}),false,now),false);assert.equal(fresh.rejectionReason,'protocol');
 assert.equal(fresh.accept(entry(now),true,now),false);assert.equal(fresh.rejectionReason,'task_priority');
});
