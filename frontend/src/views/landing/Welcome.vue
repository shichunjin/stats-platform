<template>
  <section class="hero">
    <div class="beams" aria-hidden="true">
      <div class="beam beam--left"></div>
      <div class="beam beam--right"></div>
    </div>

    <div class="content">
      <div class="badge" style="--d:0s"><span class="badge-dot"></span>新版控制台已上线</div>

      <h1 class="title" style="--d:.1s">让数据分析<br>安全地跑在云端</h1>

      <p class="subtitle" style="--d:.2s">浏览器直达 Windows 分析主机，数据按用户隔离、结果经审查导出，全程留痕可审计。</p>

      <div class="actions" style="--d:.3s">
        <router-link class="btn btn--primary" to="/login">立即开始</router-link>
        <button class="btn btn--ghost" type="button" @click="onDocs">查看使用文档</button>
      </div>

      <!-- Dashboard Mockup：1150 × 750 -->
      <div ref="stageRef" class="stage" style="--d:.45s">
        <div ref="tiltWrapRef" class="tilt-wrap" @mousemove="onTiltMove" @mouseleave="onTiltLeave">
          <div ref="tiltCardRef" class="dash">
            <div ref="glareRef" class="glare"></div>

            <!-- 左：侧边栏 -->
            <aside class="side">
              <div class="brand"><span class="brand-mark"></span><span class="brand-name">统计云平台</span></div>
              <nav class="nav">
                <span class="nav-item active">
                  <svg viewBox="0 0 14 14"><path d="M1.5 1.5h4.4v4.4H1.5zM8.1 1.5h4.4v4.4H8.1zM1.5 8.1h4.4v4.4H1.5zM8.1 8.1h4.4v4.4H8.1z"/></svg>
                  概览</span>
                <span class="nav-item">
                  <svg viewBox="0 0 14 14"><path d="M3.5 1.5h5l2 2v9h-7z"/><path d="M5 6.5h4M5 9h4"/></svg>
                  数据申请</span>
                <span class="nav-item">
                  <svg viewBox="0 0 14 14"><path d="M1.5 1.5h11L8.6 6.9v4.4L5.4 13V6.9z"/></svg>
                  数据筛选与生成</span>
                <span class="nav-item">
                  <svg viewBox="0 0 14 14"><path d="M7 1.3l4.8 1.9v3.6c0 3-2 5-4.8 6-2.8-1-4.8-3-4.8-6V3.2z"/></svg>
                  待审核导出</span>
                <span class="nav-item">
                  <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.4"/><path d="M7 4.2V7l2 1.4"/></svg>
                  审计日志</span>
              </nav>
              <div class="side-user">
                <span class="avatar">管</span>
                <div><b>admin</b><i>超级管理员</i></div>
              </div>
            </aside>

            <!-- 中：柱状图 + 日志 -->
            <main class="main">
              <div class="main-head"><b>数据总览</b><span>2026-10-22 · 周三 14:35</span></div>

              <div class="card">
                <div class="card-head">
                  <b>本周数据生成量</b>
                  <span class="legend"><i></i>生成文件</span>
                </div>
                <div class="bars">
                  <div class="bar" style="--h:38%;--i:0"><i></i><span>周一</span></div>
                  <div class="bar" style="--h:56%;--i:1"><i></i><span>周二</span></div>
                  <div class="bar" style="--h:44%;--i:2"><i></i><span>周三</span></div>
                  <div class="bar" style="--h:72%;--i:3"><i></i><span>周四</span></div>
                  <div class="bar" style="--h:60%;--i:4"><i></i><span>周五</span></div>
                  <div class="bar bar--hot" style="--h:88%;--i:5"><i></i><span>周六</span></div>
                  <div class="bar" style="--h:30%;--i:6"><i></i><span>周日</span></div>
                </div>
              </div>

              <div class="card logs">
                <div class="card-head"><b>最新日志</b><span class="card-head-link">查看全部</span></div>
                <ul>
                  <li><span class="t">14:32</span><i class="lv lv--ok"></i>user1 的导出申请已通过审核<em class="tag tag--ok">已发布</em></li>
                  <li><span class="t">13:58</span><i class="lv lv--info"></i>pgtest01 生成了 testData_20261022.xlsx<em class="tag tag--run">生成中</em></li>
                  <li><span class="t">11:20</span><i class="lv lv--warn"></i>user3 申请文件相似度 72%，转人工审核<em class="tag tag--warn">待审核</em></li>
                  <li><span class="t">10:05</span><i class="lv lv--ok"></i>管理员完成了用户数据分配<em class="tag tag--ok">已完成</em></li>
                  <li><span class="t">09:47</span><i class="lv lv--err"></i>user2 登录 Windows 主机失败（密码错误）<em class="tag tag--err">已拦截</em></li>
                </ul>
              </div>
            </main>

            <!-- 右：配置面板 -->
            <aside class="cfg">
              <div class="card stat">
                <span class="stat-label">今日生成</span>
                <div class="stat-row"><strong>128<small> 份</small></strong><span class="up">+12.4%</span></div>
              </div>

              <div class="card">
                <div class="card-head"><b>导出审核设置</b></div>
                <div class="field">
                  <div class="f-row"><label>相似度阈值</label><span class="f-val">60%</span></div>
                  <div class="slider"><i style="width:60%"></i><b style="left:60%"></b></div>
                </div>
                <div class="field row"><label>免审核自动发布</label><span class="switch on"></span></div>
                <div class="field row"><label>敏感字段告警</label><span class="switch on"></span></div>
                <div class="field row"><label>仅工作时段生成</label><span class="switch"></span></div>
                <button class="mini-btn" type="button">保存配置</button>
              </div>

              <div class="card conn">
                <div class="card-head"><b>分析主机</b></div>
                <p><span class="dot"></span>Windows Server · 在线</p>
                <p class="muted">8.133.223.251 · 延迟 23ms</p>
              </div>
            </aside>

          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

const stageRef = ref<HTMLDivElement | null>(null)
const tiltWrapRef = ref<HTMLDivElement | null>(null)
const tiltCardRef = ref<HTMLDivElement | null>(null)
const glareRef = ref<HTMLDivElement | null>(null)

const DESIGN_WIDTH = 1150
const DESIGN_HEIGHT = 750

let tiltEnabled = false
let tx = 0
let ty = 0
let cx = 0
let cy = 0
let raf: number | null = null

const canZoom: boolean =
  !!window.CSS && typeof CSS.supports === 'function' && CSS.supports('zoom', '0.5')

/* ---- 小屏自适应缩放（保持 1150×750 内部布局不变） ---- */
function fit(): void {
  const stage = stageRef.value
  const wrap = tiltWrapRef.value
  if (!stage || !wrap) return
  const s = Math.min(1, (window.innerWidth - 48) / DESIGN_WIDTH)
  if (canZoom) {
    if (s < 1) stage.style.setProperty('zoom', String(s))
    else stage.style.removeProperty('zoom')
  } else {
    wrap.style.transform = s < 1 ? `scale(${s})` : ''
    wrap.style.transformOrigin = 'top center'
    stage.style.height = s < 1 ? `${DESIGN_HEIGHT * s}px` : ''
  }
}

/* ---- 3D Tilt（rAF 插值，带高光跟随） ---- */
function loop(): void {
  const card = tiltCardRef.value
  if (!card) {
    raf = null
    return
  }
  cx += (tx - cx) * 0.12
  cy += (ty - cy) * 0.12
  card.style.transform = `rotateY(${cx.toFixed(3)}deg) rotateX(${cy.toFixed(3)}deg)`
  if (Math.abs(tx - cx) > 0.01 || Math.abs(ty - cy) > 0.01) {
    raf = requestAnimationFrame(loop)
  } else {
    raf = null
  }
}

function kick(): void {
  if (!raf) raf = requestAnimationFrame(loop)
}

function onTiltMove(e: MouseEvent): void {
  if (!tiltEnabled) return
  const wrap = e.currentTarget as HTMLElement | null
  if (!wrap) return
  const r = wrap.getBoundingClientRect()
  const px = (e.clientX - r.left) / r.width - 0.5
  const py = (e.clientY - r.top) / r.height - 0.5
  tx = px * 10
  ty = -py * 8
  const glare = glareRef.value
  if (glare) {
    glare.style.setProperty('--gx', `${((px + 0.5) * 100).toFixed(1)}%`)
    glare.style.setProperty('--gy', `${((py + 0.5) * 100).toFixed(1)}%`)
    glare.style.opacity = '1'
  }
  kick()
}

function onTiltLeave(): void {
  if (!tiltEnabled) return
  tx = 0
  ty = 0
  const glare = glareRef.value
  if (glare) glare.style.opacity = '0'
  kick()
}

function onDocs(): void {
  ElMessage.info('使用文档请联系管理员获取')
}

onMounted(() => {
  fit()
  window.addEventListener('resize', fit)
  tiltEnabled = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', fit)
  if (raf !== null) {
    cancelAnimationFrame(raf)
    raf = null
  }
})
</script>

<style scoped>
  .hero{
    --bg:#000000;
    --panel:rgba(255,255,255,.035);
    --line:rgba(255,255,255,.08);
    --txt:#f4f4f5;
    --mut:#9b9ba7;
    --mut2:#6e6e78;
    --grad:linear-gradient(90deg,#2f6bff 0%,#22d3ee 100%);
    color-scheme:dark;
    position:relative;
    width:100%;
    background:var(--bg);
    color:var(--txt);
    font-family:"Inter","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;
    overflow-x:hidden;
    -webkit-font-smoothing:antialiased;
  }
  .hero,.hero *{margin:0;padding:0;box-sizing:border-box}

  /* ========== 进场动效 ========== */
  @keyframes riseIn{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:translateY(0)}}
  @keyframes beamIn{from{opacity:0}to{opacity:1}}
  @keyframes dotPulse{0%,100%{box-shadow:0 0 0 0 rgba(103,232,249,.55)}55%{box-shadow:0 0 0 5px rgba(103,232,249,0)}}
  @keyframes grow{from{transform:scaleY(0)}}

  /* ========== Hero 容器 ========== */
  .hero{
    position:relative;
    min-height:100vh;
    overflow:hidden;
    display:flex;flex-direction:column;align-items:center;
    padding:96px 24px 110px;
  }

  /* ========== 背景光束 ========== */
  .beams{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}
  .beam{
    position:absolute;top:0;
    width:60vw;height:80vh;
    background:radial-gradient(closest-side,
      rgba(160,205,255,.75) 0%,
      rgba(70,135,235,.40) 45%,
      rgba(70,135,235,0) 85%);
    filter:blur(90px);
    opacity:0;
    animation:beamIn 1.4s ease-out 1.1s forwards; /* 内容进场后延迟 0.5s 亮起 */
  }
  .beam--left{left:0;transform-origin:top left;transform:rotate(20deg)}
  .beam--right{right:0;transform-origin:top right;transform:rotate(-20deg)}

  /* ========== 内容区 ========== */
  .content{
    position:relative;z-index:1;
    display:flex;flex-direction:column;align-items:center;
    text-align:center;max-width:960px;
  }

  /* 顶部标签 */
  .badge{
    display:inline-flex;align-items:center;gap:8px;
    padding:7px 15px;border-radius:999px;
    border:1px solid rgba(255,255,255,.13);
    background:rgba(255,255,255,.045);
    font-size:13px;color:#c3c4cd;letter-spacing:.02em;
    animation:riseIn .8s cubic-bezier(.22,.61,.36,1) both;
    animation-delay:var(--d,0s);
  }
  .badge-dot{
    width:6px;height:6px;border-radius:50%;
    background:#67e8f9;
    animation:dotPulse 2.4s ease-out infinite;
  }

  /* 主标题：白 → 中灰 渐变 */
  .title{
    margin:30px 0 22px;
    font-size:clamp(44px,6vw,74px);
    font-weight:700;
    letter-spacing:-.035em;
    line-height:1.14;
    background:linear-gradient(180deg,#ffffff 6%,#8a8d96 96%);
    -webkit-background-clip:text;background-clip:text;
    -webkit-text-fill-color:transparent;color:transparent;
    animation:riseIn .8s cubic-bezier(.22,.61,.36,1) both;
    animation-delay:var(--d,0s);
  }

  /* 副标题 */
  .subtitle{
    max-width:640px;
    font-size:19px;font-weight:400;
    line-height:1.75;color:var(--mut);
    animation:riseIn .8s cubic-bezier(.22,.61,.36,1) both;
    animation-delay:var(--d,0s);
  }

  /* 按钮组 */
  .actions{
    display:flex;gap:16px;margin-top:40px;
    animation:riseIn .8s cubic-bezier(.22,.61,.36,1) both;
    animation-delay:var(--d,0s);
  }
  .btn{
    display:inline-flex;align-items:center;justify-content:center;
    padding:14px 32px;border-radius:12px;
    font-size:15px;font-weight:600;letter-spacing:.01em;
    font-family:inherit;
    text-decoration:none;cursor:pointer;
    transition:transform .2s ease,box-shadow .2s ease,background .2s ease;
  }
  .btn--primary{
    color:#fff;background:var(--grad);
    box-shadow:0 8px 32px rgba(45,140,255,.38),0 2px 8px rgba(34,211,238,.25);
  }
  .btn--primary:hover{
    transform:translateY(-2px);
    box-shadow:0 14px 44px rgba(45,140,255,.5),0 4px 14px rgba(34,211,238,.35);
  }
  .btn--ghost{
    color:#d6d7de;
    border:1px solid rgba(255,255,255,.16);
    background:rgba(255,255,255,.03);
  }
  .btn--ghost:hover{background:rgba(255,255,255,.08);transform:translateY(-2px)}

  /* ========== Dashboard 舞台 ========== */
  .stage{
    margin-top:76px;
    animation:riseIn .9s cubic-bezier(.22,.61,.36,1) both;
    animation-delay:var(--d,0s);
  }
  .tilt-wrap{perspective:1500px}
  .dash{
    position:relative;
    width:1150px;height:750px;
    display:grid;grid-template-columns:216px 1fr 300px;gap:16px;
    padding:18px;
    border-radius:20px;
    border:1px solid rgba(255,255,255,.10);
    background:linear-gradient(180deg,rgba(19,23,33,.68),rgba(9,11,17,.62));
    backdrop-filter:blur(24px) saturate(140%);
    -webkit-backdrop-filter:blur(24px) saturate(140%);
    box-shadow:0 44px 140px rgba(0,0,0,.65),inset 0 0 0 1px rgba(255,255,255,.03);
    overflow:hidden;
    text-align:left;
    will-change:transform;
  }
  .glare{
    position:absolute;inset:0;z-index:9;pointer-events:none;
    background:radial-gradient(560px circle at var(--gx,50%) var(--gy,30%),rgba(255,255,255,.09),transparent 55%);
    opacity:0;transition:opacity .35s ease;
  }

  /* ---- 左侧边栏 ---- */
  .side{display:flex;flex-direction:column;gap:6px;padding:6px 2px}
  .brand{display:flex;align-items:center;gap:10px;padding:4px 8px 18px}
  .brand-mark{
    width:28px;height:28px;border-radius:9px;flex:none;
    background:var(--grad);
    box-shadow:0 4px 14px rgba(45,140,255,.45);
  }
  .brand-name{font-size:15px;font-weight:700;letter-spacing:.01em}
  .nav{display:flex;flex-direction:column;gap:4px}
  .nav-item{
    display:flex;align-items:center;gap:10px;
    padding:9px 12px;border-radius:10px;
    font-size:13px;color:#9494a1;text-decoration:none;
    transition:background .15s,color .15s;
  }
  .nav-item svg{width:14px;height:14px;flex:none;stroke:currentColor;fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
  .nav-item:hover{color:#d9dae2;background:rgba(255,255,255,.05)}
  .nav-item.active{
    color:#e4f4ff;
    background:linear-gradient(90deg,rgba(59,130,246,.20),rgba(34,211,238,.08));
    box-shadow:inset 0 0 0 1px rgba(96,165,250,.22);
  }
  .side-user{
    margin-top:auto;display:flex;align-items:center;gap:10px;
    padding:12px 10px;border-radius:12px;
    border:1px solid var(--line);background:var(--panel);
  }
  .avatar{
    width:30px;height:30px;border-radius:50%;flex:none;
    display:flex;align-items:center;justify-content:center;
    font-size:13px;color:#fff;background:var(--grad);
  }
  .side-user b{display:block;font-size:13px;font-weight:600}
  .side-user i{display:block;font-style:normal;font-size:11px;color:var(--mut2)}

  /* ---- 中部：图表 + 日志 ---- */
  .main{display:grid;grid-template-rows:auto minmax(0,1.35fr) minmax(0,1fr);gap:14px;min-width:0}
  .card{
    border:1px solid var(--line);border-radius:14px;
    background:var(--panel);
    padding:16px 18px;min-height:0;
    /* 覆盖平台全局浅色 .card 玻璃阴影与模糊，避免深色面板出现亮边 */
    box-shadow:none;
    backdrop-filter:none;
    -webkit-backdrop-filter:none;
  }
  .main-head{display:flex;justify-content:space-between;align-items:baseline;padding:0 2px}
  .main-head b{font-size:15px;font-weight:600}
  .main-head span{font-size:12px;color:var(--mut2);font-variant-numeric:tabular-nums}
  .card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
  .card-head b{font-size:13px;font-weight:600;color:#d7d8e0}
  .card-head .card-head-link{font-size:12px;color:#7f808b}
  .legend{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mut2)}
  .legend i{width:8px;height:8px;border-radius:2px;background:linear-gradient(180deg,#60a5fa,#2563eb)}

  /* 柱状图 */
  .bars{display:flex;align-items:stretch;gap:12px;height:calc(100% - 30px);min-height:0}
  .bar{
    flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:8px;
    height:100%;
  }
  .bar i{
    width:min(34px,62%);height:var(--h);
    border-radius:7px 7px 3px 3px;
    background:linear-gradient(180deg,rgba(96,165,250,.85),rgba(37,99,235,.55));
    transform-origin:bottom;
    animation:grow .7s cubic-bezier(.22,.61,.36,1) both;
    animation-delay:calc(1.3s + var(--i)*.06s);
  }
  .bar span{font-size:11px;color:var(--mut2)}
  .bar--hot i{
    background:linear-gradient(180deg,#67e8f9,#3b82f6);
    box-shadow:0 0 22px rgba(56,189,248,.45);
  }
  .bar--hot span{color:#a5e6ff}

  /* 日志列表 */
  .logs ul{list-style:none}
  .logs li{
    display:grid;grid-template-columns:44px 10px 1fr auto;gap:10px;align-items:center;
    padding:9px 2px;font-size:13px;color:#c0c1cb;
    border-bottom:1px dashed rgba(255,255,255,.06);
  }
  .logs li:last-child{border-bottom:none}
  .logs .t{font-size:12px;color:var(--mut2);font-variant-numeric:tabular-nums}
  .lv{width:7px;height:7px;border-radius:50%}
  .lv--ok{background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.7)}
  .lv--info{background:#60a5fa;box-shadow:0 0 8px rgba(96,165,250,.7)}
  .lv--warn{background:#fbbf24;box-shadow:0 0 8px rgba(251,191,36,.7)}
  .lv--err{background:#f87171;box-shadow:0 0 8px rgba(248,113,113,.7)}
  .tag{padding:2px 9px;border-radius:999px;font-size:11px;white-space:nowrap}
  .tag--ok{background:rgba(52,211,153,.12);color:#6ee7b7}
  .tag--run{background:rgba(96,165,250,.12);color:#93c5fd}
  .tag--warn{background:rgba(251,191,36,.12);color:#fcd34d}
  .tag--err{background:rgba(248,113,113,.12);color:#fca5a5}

  /* ---- 右侧配置面板 ---- */
  .cfg{display:flex;flex-direction:column;gap:14px;min-width:0}
  .stat strong{font-size:30px;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
  .stat small{font-size:13px;font-weight:400;color:var(--mut)}
  .stat-row{display:flex;align-items:center;gap:10px;margin-top:6px}
  .up{
    font-size:12px;color:#34d399;
    background:rgba(52,211,153,.1);
    padding:2px 9px;border-radius:999px;
    font-variant-numeric:tabular-nums;
  }
  .stat-label{font-size:12px;color:var(--mut2)}
  .f-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#c6c7d1}
  .f-val{font-size:12px;color:#a5e6ff;font-variant-numeric:tabular-nums}
  .slider{
    position:relative;height:6px;border-radius:999px;margin-top:10px;
    background:rgba(255,255,255,.09);
  }
  .slider i{
    position:absolute;left:0;top:0;bottom:0;border-radius:999px;
    background:var(--grad);
  }
  .slider b{
    position:absolute;top:50%;width:14px;height:14px;border-radius:50%;
    transform:translate(-50%,-50%);
    background:#fff;box-shadow:0 0 10px rgba(103,232,249,.9);
  }
  .field{margin-bottom:14px}
  .field.row{display:flex;justify-content:space-between;align-items:center;margin-bottom:0;padding:9px 0}
  .switch{
    position:relative;width:34px;height:20px;border-radius:999px;flex:none;
    background:rgba(255,255,255,.13);
  }
  .switch::after{
    content:"";position:absolute;top:2px;left:2px;
    width:16px;height:16px;border-radius:50%;background:#e8e8ee;
    transition:left .2s ease;
  }
  .switch.on{background:var(--grad)}
  .switch.on::after{left:16px}
  .mini-btn{
    width:100%;margin-top:6px;padding:9px;border:none;border-radius:10px;
    font-size:13px;font-weight:600;color:#fff;font-family:inherit;
    background:var(--grad);cursor:pointer;
    box-shadow:0 4px 16px rgba(45,140,255,.3);
  }
  .conn p{display:flex;align-items:center;gap:8px;font-size:13px;color:#c6c7d1;margin-bottom:6px}
  .conn .dot{width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.7)}
  .conn .muted{font-size:12px;color:var(--mut2);margin-bottom:0}

  /* 小屏缩放兜底 */
  @media (max-width:1220px){.hero{padding-top:72px}}

  @media (prefers-reduced-motion:reduce){
    .hero,.hero *,.hero *::before,.hero *::after{animation:none!important;transition:none!important}
    .beam{opacity:1}
  }
</style>
