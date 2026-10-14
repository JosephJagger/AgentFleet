import {expect,it} from 'vitest';
import {curlFlow,Fluid,MatrixRain,ParticleField} from './lib/buzhoushan-effects';
const seeded=()=>{let s=12345;return()=>((s=(s*1664525+1013904223)>>>0)/4294967296);};

it('curl flow is divergence-free (finite differences)',()=>{
 const e=1e-4;
 for(const [u,v,t] of [[.2,.3,0],[.7,.1,5],[.5,.9,11]]){
  const dudx=(curlFlow(u+e,v,t)[0]-curlFlow(u-e,v,t)[0])/(2*e),dvdy=(curlFlow(u,v+e,t)[1]-curlFlow(u,v-e,t)[1])/(2*e);
  expect(Math.abs(dudx+dvdy)).toBeLessThan(1e-3);
 }
});
it('keeps 40k particles finite and inside the buffer, even with a pointer',()=>{
 const f=new ParticleField(40000,320,180,seeded());
 for(let i=0;i<120;i++)f.step(1/60,i/60,i%2===0,{x:.5,y:.5,active:true});
 for(let i=0;i<f.n;i+=97){
  expect(Number.isFinite(f.x[i])&&Number.isFinite(f.vx[i])).toBe(true);
  expect(f.x[i]).toBeGreaterThanOrEqual(0);expect(f.x[i]).toBeLessThan(320);
  expect(f.y[i]).toBeGreaterThanOrEqual(0);expect(f.y[i]).toBeLessThan(180);
 }
 const data=new Uint8ClampedArray(320*180*4);f.render(data,1/60,false);
 expect(data.some(v=>v>0)).toBe(true);
});
it('pointer repels nearby particles',()=>{
 const f=new ParticleField(1,200,200,()=>.5);f.x[0]=105;f.y[0]=100;f.vx[0]=0;f.vy[0]=0;f.life[0]=9;
 f.step(1/60,0,false,{x:.5,y:.5,active:true});
 expect(f.vx[0]).toBeGreaterThan(0);
});
it('pressure projection removes divergence and the solver stays stable',()=>{
 const fl=new Fluid(64,36);
 for(let k=0;k<fl.u.length;k++){fl.u[k]=Math.sin(k*.37)*20;fl.v[k]=Math.cos(k*.21)*20;}
 const before=fl.divergence();fl.project(60);
 expect(fl.divergence()).toBeLessThan(before*.35);
 for(let i=0;i<200;i++){fl.splat(.5+.3*Math.sin(i/9),.5,Math.cos(i/9)*60,30,[.3,.2,.5]);fl.step(.033);}
 expect(fl.u.every(Number.isFinite)&&fl.dye[0].every(Number.isFinite)).toBe(true);
 expect(Math.max(...fl.dye[0])).toBeGreaterThan(0);expect(Math.max(...fl.dye[0])).toBeLessThan(50);
});
it('matrix rain resets columns that leave the screen',()=>{
 const m=new MatrixRain(16,seeded());m.resize(160,160);
 expect(m.cols).toBe(10);
 const calls:string[]=[];
 const ctx={fillRect(){},fillText(_g:string,_x:number,_y:number){calls.push('t');},set fillStyle(_v:string){},set font(_v:string){},set textBaseline(_v:string){}} as unknown as CanvasRenderingContext2D;
 for(let i=0;i<600;i++)m.frame(ctx,1/30,false,{x:.5,y:.5,active:true});
 expect(calls.length).toBeGreaterThan(100);
 expect(Array.from(m.head).every(h=>h<=m.rows+3)).toBe(true);
});
