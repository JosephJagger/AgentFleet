export interface PanelTransportBinding {transportGeneration:number;producerEpoch:string;appServerEpoch:string;}
export interface PanelAgentBinding {identity:{transportGeneration:number};reconciliationReady:boolean;producerEpoch?:string;appServerEpoch?:string;verifiedVoiceBinding?:PanelTransportBinding;}
/** A directory re-hello freezes task admission, not an already verified audio call.
 * Only existing control operations may use the previous verification on this same
 * socket generation. New calls and changed native processes remain fenced.
 */
export function panelVoiceBindingMatches(agent:PanelAgentBinding|undefined,binding:PanelTransportBinding,action:string):boolean {
 if(!agent||agent.identity.transportGeneration!==binding.transportGeneration)return false;
 const verified=agent.reconciliationReady?{transportGeneration:agent.identity.transportGeneration,producerEpoch:agent.producerEpoch,appServerEpoch:agent.appServerEpoch}
  :['heartbeat','stop','tool.result'].includes(action)?agent.verifiedVoiceBinding:undefined;
 return Boolean(verified&&verified.transportGeneration===binding.transportGeneration&&verified.producerEpoch===binding.producerEpoch&&verified.appServerEpoch===binding.appServerEpoch);
}
