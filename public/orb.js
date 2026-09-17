// Scout's presence: a folding ribbon of colour inside an invisible sphere.
// three.js — ribbon rendered offscreen, blurred, composited with a crisp edge pass.
import * as THREE from "three";

const PF = [[0.66, 0.80, 1.00], [1.00, 0.93, 0.72], [1.00, 0.72, 0.60], [0.95, 0.40, 0.33], [0.99, 0.83, 0.80]];

export function createOrb(canvas, { size = 220, onReady = null } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: "high-performance" });
  const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(DPR); renderer.setSize(size, size, false); renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 10); camera.position.set(0, 0, 3.3);
  const U = {
    uTime: { value: 0 }, uSpeed: { value: 1 }, uWidth: { value: 0.30 }, uTwist: { value: 1.2 },
    uA: { value: 1.0 }, uB: { value: 1.6 }, uR: { value: 0.72 }, uSpan: { value: 3.6 }, uCrisp: { value: 0 },
    c0: { value: new THREE.Vector3(...PF[0]) }, c1: { value: new THREE.Vector3(...PF[1]) }, c2: { value: new THREE.Vector3(...PF[2]) },
    c3: { value: new THREE.Vector3(...PF[3]) }, c4: { value: new THREE.Vector3(...PF[4]) },
  };
  const VS = `
uniform float uTime,uSpeed,uWidth,uTwist,uA,uB,uR,uSpan;
varying vec2 vUv; varying vec3 vN; varying vec3 vP;
vec3 curve(float u){
  float s=u*uSpan+uTime*0.32*uSpeed; float ph=uTime*0.19*uSpeed;
  float lat=sin(uB*s+ph)*(0.45+0.35*sin(uTime*0.23*uSpeed));
  float lon=uA*s+0.6*sin(uTime*0.13*uSpeed);
  return uR*vec3(cos(lat)*cos(lon), sin(lat), cos(lat)*sin(lon));
}
vec3 surf(float u,float v){
  float e=0.002; vec3 c=curve(u);
  vec3 T=normalize(curve(u+e)-curve(u-e)); vec3 N=normalize(c); vec3 B=normalize(cross(T,N)); N=normalize(cross(B,T));
  float th=uTwist*u*6.2831+uTime*1.1*uSpeed+1.2*sin(uTime*0.4*uSpeed);
  vec3 dir=cos(th)*N+sin(th)*B;
  float w=uWidth*pow(sin(3.14159*u),0.65); float curl=0.18*v*v*w;
  return c+dir*v*w+N*curl*sin(uTime*0.7*uSpeed+u*4.0);
}
void main(){
  float u=position.x+0.5; float v=position.y;
  vec3 p=surf(u,v); vec3 pu=surf(u+0.004,v); vec3 pv=surf(u,v+0.03);
  vec3 n=normalize(cross(pu-p,pv-p));
  vUv=vec2(u,v); vN=normalMatrix*n; vP=(modelViewMatrix*vec4(p,1.0)).xyz;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
}`;
  const FS = `
uniform vec3 c0,c1,c2,c3,c4; uniform float uCrisp,uTime;
varying vec2 vUv; varying vec3 vN; varying vec3 vP;
vec3 grad(float x){ x=clamp(x,0.0,1.0)*4.0; if(x<1.0)return mix(c0,c1,x); if(x<2.0)return mix(c1,c2,x-1.0); if(x<3.0)return mix(c2,c3,x-2.0); return mix(c3,c4,x-3.0); }
void main(){
  vec3 n=normalize(vN); vec3 v=normalize(-vP);
  float edge=pow(1.0-abs(dot(n,v)),1.6);
  vec3 col=grad(vUv.x*0.9+0.08*vUv.y+0.05*sin(uTime*0.2));
  col=mix(col,pow(col,vec3(1.9))*1.05,edge*0.85);
  float a=mix(0.18,0.95,edge)*smoothstep(0.0,0.06,vUv.x)*smoothstep(1.0,0.94,vUv.x);
  if(uCrisp>0.5){a*=smoothstep(0.35,0.9,edge)*0.9;}
  gl_FragColor=vec4(col,a);
}`;
  const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(1, 2, 150, 14),
    new THREE.ShaderMaterial({ uniforms: U, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
  scene.add(ribbon);

  const W = Math.round(size * DPR), half = Math.round(W / 3);
  const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false };
  const rtCrisp = new THREE.WebGLRenderTarget(W, W, opts), rtSoft = new THREE.WebGLRenderTarget(half, half, opts);
  const rtA = new THREE.WebGLRenderTarget(half, half, opts), rtB = new THREE.WebGLRenderTarget(half, half, opts);
  const quadGeo = new THREE.PlaneGeometry(2, 2), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blur = new THREE.ShaderMaterial({
    uniforms: { tex: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, texel: { value: 1 / half }, radius: { value: 0.65 } },
    vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position,1.0);}`,
    fragmentShader: `uniform sampler2D tex;uniform vec2 dir;uniform float texel,radius;varying vec2 vUv;
      void main(){float w[7];w[0]=0.1964;w[1]=0.1746;w[2]=0.1210;w[3]=0.0655;w[4]=0.0276;w[5]=0.0091;w[6]=0.0023;
      vec4 s=texture2D(tex,vUv)*w[0];for(int i=1;i<7;i++){vec2 o=dir*texel*radius*float(i)*1.6;s+=texture2D(tex,vUv+o)*w[i];s+=texture2D(tex,vUv-o)*w[i];}gl_FragColor=s;}`,
    depthTest: false, depthWrite: false });
  const blurScene = new THREE.Scene(); blurScene.add(new THREE.Mesh(quadGeo, blur));
  const comp = new THREE.ShaderMaterial({
    uniforms: { crisp: { value: null }, soft: { value: null } },
    vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position,1.0);}`,
    fragmentShader: `uniform sampler2D crisp,soft;varying vec2 vUv;
      void main(){vec2 p=(vUv-0.5)*2.0;float r=length(p)/0.86;float mask=1.0-smoothstep(0.96,1.04,r);
      vec4 s=texture2D(soft,vUv);vec4 c=texture2D(crisp,vUv);
      gl_FragColor=vec4((s.rgb*0.9+c.rgb*0.8)*mask,clamp(s.a*0.9+c.a*0.8,0.0,1.0)*mask);}`,
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor });
  const compScene = new THREE.Scene(); compScene.add(new THREE.Mesh(quadGeo, comp));

  const targets = [
    { speed: 1.0, width: 0.30, twist: 1.2, energy: 0 },
    { speed: 0.7, width: 0.38, twist: 0.8, energy: 0.5 },
    { speed: 2.2, width: 0.26, twist: 2.0, energy: 0.9 },
    { speed: 1.4, width: 0.33, twist: 1.4, energy: 0.7 },
  ];
  const cur = { speed: 1, width: 0.30, twist: 1.2, energy: 0 };
  let state = 0, running = true, t = 0, last = performance.now(), raf = 0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pass = (rt, tex, dx, dy) => { blur.uniforms.tex.value = tex; blur.uniforms.dir.value.set(dx, dy); renderer.setRenderTarget(rt); renderer.clear(); renderer.render(blurScene, quadCam); };

  let ready = false, lastRender = 0;
  const touch = matchMedia("(pointer: coarse)").matches;
  const MIN_INTERVAL = touch ? 31 : 15; // phones: ~30fps by time, so a 30Hz Low Power screen still gets every frame
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!running) { last = now; return; }
    if (ready && now - lastRender < MIN_INTERVAL) return;
    lastRender = now;
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (!reduced) t += dt;
    const tg = targets[state]; for (const k in cur) cur[k] += (tg[k] - cur[k]) * 0.04;
    let width = cur.width; if (state === 3) width *= 1 + 0.18 * Math.sin(t * 5.2);
    U.uTime.value = t; U.uSpeed.value = cur.speed; U.uWidth.value = width; U.uTwist.value = cur.twist;
    U.uSpan.value = 3.4 + 1.0 * Math.sin(t * 0.31 * cur.speed);
    ribbon.rotation.y = t * 0.28 * cur.speed; ribbon.rotation.x = 0.25 + 0.45 * Math.sin(t * 0.27); ribbon.rotation.z = 0.3 * Math.sin(t * 0.17);
    U.uCrisp.value = 0; renderer.setRenderTarget(rtSoft); renderer.clear(); renderer.render(scene, camera);
    blur.uniforms.radius.value = 1.0 + 0.5 * cur.energy;
    pass(rtA, rtSoft.texture, 1, 0); pass(rtB, rtA.texture, 0, 1);
    U.uCrisp.value = 1; renderer.setRenderTarget(rtCrisp); renderer.clear(); renderer.render(scene, camera);
    comp.uniforms.soft.value = rtB.texture; comp.uniforms.crisp.value = rtCrisp.texture;
    renderer.setRenderTarget(null); renderer.clear(); renderer.render(compScene, quadCam);
    if (!ready) { ready = true; onReady && onReady(); }
  }
  raf = requestAnimationFrame(frame);
  return {
    setState(i) { state = i; },
    pause() { running = false; },
    resume() { running = true; last = performance.now(); },
    destroy() { cancelAnimationFrame(raf); renderer.dispose(); },
  };
}
