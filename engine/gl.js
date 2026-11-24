/* SekaiGL — WebGL2 バッチ描画（論理座標 1920×1080）
   頂点＝x,y,u·q,v·q,q,r,g,b,a。q が reciprocalW（奥行きの逆数）で、フラグメントで (u·q,v·q)/q を取るため、
   斜めの台形でもテクスチャが歪まない（GPUで透視補正）。同じ(レイヤー,テクスチャ,ブレンド)の四角形は1回の drawElements にまとめる */
(function(root){
const VS='#version 300 es\nin vec2 p;in vec3 t;in vec4 c;uniform vec2 R;out vec3 vt;out vec4 vc;void main(){gl_Position=vec4(p.x/R.x*2.-1.,1.-p.y/R.y*2.,0.,1.);vt=t;vc=c;}';
const FS='#version 300 es\nprecision highp float;in vec3 vt;in vec4 vc;uniform sampler2D S;out vec4 o;void main(){o=texture(S,vt.xy/vt.z)*vc;}';
const sh=(g,t,s)=>{const o=g.createShader(t);g.shaderSource(o,s);g.compileShader(o);if(!g.getShaderParameter(o,g.COMPILE_STATUS))throw new Error(g.getShaderInfoLog(o));return o};
class Renderer{
 constructor(cv,W=1920,H=1080){
  const g=cv.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false});if(!g)throw new Error('WebGL2 が使えません');
  cv.width=W;cv.height=H;Object.assign(this,{g,cv,W,H,nT:0,B:new Map(),draws:0,MAXQ:16000});
  const pr=this.pr=g.createProgram();g.attachShader(pr,sh(g,g.VERTEX_SHADER,VS));g.attachShader(pr,sh(g,g.FRAGMENT_SHADER,FS));
  g.bindAttribLocation(pr,0,'p');g.bindAttribLocation(pr,1,'t');g.bindAttribLocation(pr,2,'c');g.linkProgram(pr);
  if(!g.getProgramParameter(pr,g.LINK_STATUS))throw new Error(g.getProgramInfoLog(pr));
  this.uR=g.getUniformLocation(pr,'R');this.vao=g.createVertexArray();g.bindVertexArray(this.vao);
  this.vb=g.createBuffer();g.bindBuffer(g.ARRAY_BUFFER,this.vb);
  for(const[i,n,o]of[[0,2,0],[1,3,8],[2,4,20]]){g.enableVertexAttribArray(i);g.vertexAttribPointer(i,n,g.FLOAT,false,36,o)}
  const ix=new Uint16Array(this.MAXQ*6);for(let i=0;i<this.MAXQ;i++)ix.set([i*4,i*4+1,i*4+2,i*4,i*4+2,i*4+3],i*6);
  this.ib=g.createBuffer();g.bindBuffer(g.ELEMENT_ARRAY_BUFFER,this.ib);g.bufferData(g.ELEMENT_ARRAY_BUFFER,ix,g.STATIC_DRAW);g.enable(g.BLEND)}
 texture(img){const g=this.g,t=g.createTexture();g.bindTexture(g.TEXTURE_2D,t);g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
  g.texImage2D(g.TEXTURE_2D,0,g.RGBA,g.RGBA,g.UNSIGNED_BYTE,img);g.generateMipmap(g.TEXTURE_2D);
  g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MIN_FILTER,g.LINEAR_MIPMAP_LINEAR);g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MAG_FILTER,g.LINEAR);
  g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_S,g.CLAMP_TO_EDGE);g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_T,g.CLAMP_TO_EDGE);
  return{t,w:img.width,h:img.height,id:++this.nT}}
 begin(){this.B.clear();this.draws=0}
 /* P=[x0,y0,…x3,y3]（左上→右上→右下→左下）／uv=[u0,v0,u1,v1]（テクスチャのピクセル）／q=[q0..q3]（reciprocalW。正対なら null）／rgba は非乗算(0..1) */
 quad(tx,P,uv,q,rgba=[1,1,1,1],layer=0,add=false){
  const k=layer+'|'+tx.id+'|'+(add?1:0);let b=this.B.get(k);if(!b){b={tx,add,layer,v:[],n:0};this.B.set(k,b)}
  const U=[uv[0],uv[2],uv[2],uv[0]],V=[uv[1],uv[1],uv[3],uv[3]],a=rgba[3];
  for(let i=0;i<4;i++){const w=q?q[i]:1;b.v.push(P[2*i],P[2*i+1],U[i]/tx.w*w,V[i]/tx.h*w,w,rgba[0]*a,rgba[1]*a,rgba[2]*a,a)}b.n++}
 end(){const g=this.g;g.viewport(0,0,this.W,this.H);g.clearColor(0,0,0,0);g.clear(g.COLOR_BUFFER_BIT);g.useProgram(this.pr);g.uniform2f(this.uR,this.W,this.H);
  g.bindVertexArray(this.vao);g.bindBuffer(g.ARRAY_BUFFER,this.vb);g.activeTexture(g.TEXTURE0);
  for(const b of[...this.B.values()].sort((a,c)=>a.layer-c.layer)){g.bindTexture(g.TEXTURE_2D,b.tx.t);g.blendFunc(g.ONE,b.add?g.ONE:g.ONE_MINUS_SRC_ALPHA);
   for(let s=0;s<b.n;s+=this.MAXQ){const m=Math.min(this.MAXQ,b.n-s);g.bufferData(g.ARRAY_BUFFER,new Float32Array(b.v.slice(s*36,(s+m)*36)),g.DYNAMIC_DRAW);g.drawElements(g.TRIANGLES,m*6,g.UNSIGNED_SHORT,0);this.draws++}}}
}
const loadImage=u=>new Promise((ok,ng)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>ng(new Error('読み込めません: '+u));i.src=u});
root.SekaiGL={Renderer,loadImage};
})(typeof window!=='undefined'?window:globalThis);
