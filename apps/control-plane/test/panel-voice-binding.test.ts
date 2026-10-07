import test from 'node:test';
import assert from 'node:assert/strict';
import {panelVoiceBindingMatches,type PanelAgentBinding} from '../src/panel-voice-binding.js';
test('an existing call survives directory resynchronization while new work remains fenced',()=>{
 const binding={transportGeneration:7,producerEpoch:'producer',appServerEpoch:'native'};
 const agent:PanelAgentBinding={identity:{transportGeneration:7},reconciliationReady:true,producerEpoch:'producer',appServerEpoch:'native',verifiedVoiceBinding:binding};
 assert.equal(panelVoiceBindingMatches(agent,binding,'start'),true);
 agent.reconciliationReady=false;delete agent.producerEpoch;delete agent.appServerEpoch;
 for(const action of ['heartbeat','stop','tool.result'])assert.equal(panelVoiceBindingMatches(agent,binding,action),true);
 for(const action of ['start','dispatch','report'])assert.equal(panelVoiceBindingMatches(agent,binding,action),false);
 agent.reconciliationReady=true;agent.producerEpoch='producer';agent.appServerEpoch='native';assert.equal(panelVoiceBindingMatches(agent,binding,'heartbeat'),true);
});
test('generation changes, native restart and unverified connections cannot reuse call control',()=>{
 const binding={transportGeneration:7,producerEpoch:'p',appServerEpoch:'a'};
 const agent:PanelAgentBinding={identity:{transportGeneration:8},reconciliationReady:false,verifiedVoiceBinding:binding};
 assert.equal(panelVoiceBindingMatches(agent,binding,'heartbeat'),false);
 agent.identity.transportGeneration=7;agent.reconciliationReady=true;agent.producerEpoch='p';agent.appServerEpoch='changed';assert.equal(panelVoiceBindingMatches(agent,binding,'heartbeat'),false);
 agent.reconciliationReady=false;delete agent.verifiedVoiceBinding;assert.equal(panelVoiceBindingMatches(agent,binding,'tool.result'),false);assert.equal(panelVoiceBindingMatches(undefined,binding,'heartbeat'),false);
});
