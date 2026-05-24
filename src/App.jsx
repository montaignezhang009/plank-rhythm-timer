import React, { useEffect, useRef } from 'react';

export default function App() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let scale = window.devicePixelRatio || 1;

    // --- 1. 状态与配置数据 (带 LocalStorage 记忆) ---
    let config = {
      workTime: parseInt(localStorage.getItem('plank_work_time')) || 20,
      restTime: parseInt(localStorage.getItem('plank_rest_time')) || 30,
      totalRounds: parseInt(localStorage.getItem('plank_total_rounds')) || 3
    };

    let state = {
      status: 'config',
      subStatus: 'prepare',
      currentRound: 1,
      timeLeft: 5,
      isPaused: false
    };

    // UI 颜色过渡平滑阻尼器
    let backgroundColors = {
      config: { r: 9, g: 13, b: 22 },
      prepare: { r: 217, g: 119, b: 6 },
      work: { r: 5, g: 150, b: 105 },
      rest: { r: 37, g: 99, b: 235 }
    };
    let currentBg = { r: 9, g: 13, b: 22 };

    // 绝对时钟物理引擎参数
    let targetEndTime = 0;
    let pausedRemainingTime = 0;
    let phaseDuration = 5;
    let lastSpokenSec = -1;

    // 动效插值变量
    let progressRing = 1.0;
    let targetRing = 1.0;
    let clickFeedback = {};

    // 声音相关状态
    let soundEnabled = localStorage.getItem('plank_sound') !== 'off';
    let wakeLock = null;

    // 背景浮动粒子
    let particles = [];
    for (let i = 0; i < 25; i++) {
      particles.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.001,
        vy: (Math.random() - 0.5) * 0.001,
        size: Math.random() * 2 + 1,
        alpha: Math.random() * 0.5 + 0.1
      });
    }

    // ============================================================
    // --- 2. 音频引擎 (Web Audio API —— iOS Safari 上稳定可靠) ---
    // ============================================================
    // 设计：核心提示音用 Web Audio 当场合成，零文件、必出声。
    // 同时预留人声接口：若 /audio/ 目录存在对应 mp3，会一并播放人声。
    let audioCtx = null;
    const voiceBuffers = {};   // 缓存已加载的人声音频
    let voiceTriedLoad = false;

    // 需要的人声文件名（以后把这些 mp3 放进 public/audio/ 即可自动启用人声）
    // 例：public/audio/1.mp3, 2.mp3 ... start.mp3, rest.mp3 ...
    const voiceFiles = {
      '1': '1', '2': '2', '3': '3', '4': '4', '5': '5',
      start: 'start', rest: 'rest', ready: 'ready',
      complete: 'complete', go: 'go'
    };

    let masterGain = null;
    function ensureAudioCtx() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          audioCtx = new AC();
          // 主增益 + 压缩器：把整体音量推到最大且不破音
          masterGain = audioCtx.createGain();
          masterGain.gain.value = 1.0;
          const comp = audioCtx.createDynamicsCompressor();
          comp.threshold.value = -24;
          comp.ratio.value = 12;
          comp.attack.value = 0.002;
          comp.release.value = 0.15;
          masterGain.connect(comp);
          comp.connect(audioCtx.destination);
        }
      }
      // iOS 关键：在用户手势里 resume，激活后整段训练都能出声
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      return audioCtx;
    }

    // 尝试异步加载人声 mp3（没有文件就静默跳过，完全不影响音效）
    function tryLoadVoices() {
      if (voiceTriedLoad || !audioCtx) return;
      voiceTriedLoad = true;
      Object.keys(voiceFiles).forEach(key => {
        const url = `audio/${voiceFiles[key]}.mp3`;
        fetch(url)
          .then(res => { if (!res.ok) throw new Error('no file'); return res.arrayBuffer(); })
          .then(buf => audioCtx.decodeAudioData(buf))
          .then(decoded => { voiceBuffers[key] = decoded; })
          .catch(() => { /* 该词没有人声文件，忽略，用音效即可 */ });
      });
    }

    // 播放一个合成提示音（type 决定音色/音高）—— 大音量版
    function playTone(type) {
      const ac = ensureAudioCtx();
      if (!ac || !masterGain) return;

      const now = ac.currentTime;

      // 参数：freq 基频, dur 时长, vol 峰值(接近1), wave 波形, ramp 滑音目标
      let freq = 880, dur = 0.12, vol = 0.9, wave = 'triangle', ramp = null;

      if (type === 'tick') {
        freq = 700; dur = 0.07; vol = 0.7; wave = 'triangle';
      } else if (type === 'count') {
        freq = 900; dur = 0.13; vol = 1.0; wave = 'square';
      } else if (type === 'start') {
        freq = 540; dur = 0.22; vol = 1.0; wave = 'square'; ramp = 820;
      } else if (type === 'rest') {
        freq = 440; dur = 0.22; vol = 1.0; wave = 'square'; ramp = 300;
      } else if (type === 'ready') {
        freq = 760; dur = 0.16; vol = 0.95; wave = 'square';
      } else if (type === 'complete') {
        freq = 1046; dur = 0.55; vol = 1.0; wave = 'square'; ramp = 1568;
      } else if (type === 'pause') {
        freq = 320; dur = 0.16; vol = 0.8; wave = 'triangle';
      } else if (type === 'resume') {
        freq = 620; dur = 0.16; vol = 0.8; wave = 'triangle';
      }

      // 双振荡器叠加：基频 + 高八度，声音更饱满穿透
      const g = ac.createGain();
      g.connect(masterGain);

      const osc1 = ac.createOscillator();
      osc1.type = wave;
      osc1.frequency.setValueAtTime(freq, now);
      if (ramp) osc1.frequency.exponentialRampToValueAtTime(ramp, now + dur);

      const osc2 = ac.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(freq * 2, now);
      if (ramp) osc2.frequency.exponentialRampToValueAtTime(ramp * 2, now + dur);

      osc1.connect(g);
      osc2.connect(g);

      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(vol, now + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      osc1.start(now); osc2.start(now);
      osc1.stop(now + dur + 0.03);
      osc2.stop(now + dur + 0.03);
    }

    // 播放人声（若已加载到对应 buffer）
    function playVoice(key) {
      const ac = ensureAudioCtx();
      if (!ac || !voiceBuffers[key]) return false;
      const src = ac.createBufferSource();
      src.buffer = voiceBuffers[key];
      src.connect(masterGain || ac.destination);
      src.start(0);
      return true;
    }

    // ============================================================
    // --- 3. 统一发声入口 cue() ---
    // 同时尝试人声 + 必定播放音效，构成双保险
    // ============================================================
    function cue(key) {
      if (!soundEnabled) return;
      ensureAudioCtx();

      // 数字 1-5：人声优先，音效兜底
      if (['1', '2', '3', '4', '5'].includes(key)) {
        playVoice(key);
        playTone('count');
        return;
      }

      // 语义化提示
      switch (key) {
        case 'start':
          playVoice('start'); playTone('start'); break;
        case 'rest':
          playVoice('rest'); playTone('rest'); break;
        case 'ready':
          playVoice('ready'); playTone('ready'); break;
        case 'complete':
          playVoice('complete'); playTone('complete'); break;
        case 'pause':
          playTone('pause'); break;
        case 'resume':
          playTone('resume'); break;
        case 'tick':
          playTone('tick'); break;
        case 'test':
          // 测试：依次给一个完整反馈
          playVoice('ready'); playTone('ready');
          setTimeout(() => { playVoice('start'); playTone('start'); }, 350);
          break;
        default:
          playTone('count');
      }
    }

    // 音频解锁：在首次用户手势里激活 AudioContext 并尝试加载人声
    function unlockAudio() {
      const ac = ensureAudioCtx();
      if (ac) {
        // 播放一个几乎无声的极短音来彻底激活通道
        const now = ac.currentTime;
        const osc = ac.createOscillator();
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, now);
        osc.connect(g); g.connect(ac.destination);
        osc.start(now); osc.stop(now + 0.01);
        tryLoadVoices();
      }
    }

    // --- 4. Wake Lock 唤醒锁 ---
    async function requestWakeLock() {
      if ('wakeLock' in navigator) {
        try {
          wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
          console.warn("屏幕锁申请受限: ", err.message);
        }
      }
    }

    function releaseWakeLock() {
      if (wakeLock) {
        wakeLock.release().then(() => wakeLock = null).catch(() => {});
      }
    }

    // --- 5. 存储配置 ---
    function saveConfig() {
      localStorage.setItem('plank_work_time', config.workTime);
      localStorage.setItem('plank_rest_time', config.restTime);
      localStorage.setItem('plank_total_rounds', config.totalRounds);
    }

    // --- 6. 绝对物理时钟计时器 ---
    let tickTimeoutId = null;
    function startTraining() {
      unlockAudio();
      requestWakeLock();

      state.status = 'training';
      state.subStatus = 'prepare';
      state.currentRound = 1;
      state.timeLeft = 5;
      state.isPaused = false;
      phaseDuration = 5;

      targetEndTime = Date.now() + 5000;
      lastSpokenSec = -1;

      cue('ready');
      tick();
    }

    function togglePause() {
      if (state.isPaused) {
        targetEndTime = Date.now() + pausedRemainingTime;
        state.isPaused = false;
        cue('resume');
      } else {
        pausedRemainingTime = targetEndTime - Date.now();
        state.isPaused = true;
        cue('pause');
      }
    }

    function resetTraining() {
      state.status = 'config';
      releaseWakeLock();
      if (tickTimeoutId) clearTimeout(tickTimeoutId);
      draw();
    }

    function handlePhaseTransition() {
      if (state.subStatus === 'prepare') {
        state.subStatus = 'work';
        state.timeLeft = config.workTime;
        phaseDuration = config.workTime;
        targetEndTime = Date.now() + (config.workTime * 1000);
        lastSpokenSec = -1;
        cue('start');
      } else if (state.subStatus === 'work') {
        if (state.currentRound >= config.totalRounds) {
          cue('complete');
          resetTraining();
        } else {
          state.subStatus = 'rest';
          state.timeLeft = config.restTime;
          phaseDuration = config.restTime;
          targetEndTime = Date.now() + (config.restTime * 1000);
          lastSpokenSec = -1;
          cue('rest');
        }
      } else if (state.subStatus === 'rest') {
        state.currentRound++;
        state.subStatus = 'work';
        state.timeLeft = config.workTime;
        phaseDuration = config.workTime;
        targetEndTime = Date.now() + (config.workTime * 1000);
        lastSpokenSec = -1;
        cue('start');
      }
    }

    function triggerVoiceAnnouncements(sec) {
      if (state.subStatus === 'prepare') {
        if (sec <= 4 && sec >= 1) cue(sec.toString());
      } else if (state.subStatus === 'work') {
        if (sec <= 5 && sec >= 1) cue(sec.toString());
      } else if (state.subStatus === 'rest') {
        if (sec === 5) cue('ready');
        else if (sec < 5 && sec >= 1) cue(sec.toString());
      }
    }

    function tick() {
      if (state.status !== 'training') return;

      if (!state.isPaused) {
        let msLeft = targetEndTime - Date.now();
        if (msLeft <= 0) {
          handlePhaseTransition();
        } else {
          let sec = Math.max(0, Math.ceil(msLeft / 1000));
          if (sec !== state.timeLeft) {
            state.timeLeft = sec;
          }
          targetRing = msLeft / (phaseDuration * 1000);

          if (state.timeLeft !== lastSpokenSec) {
            lastSpokenSec = state.timeLeft;
            triggerVoiceAnnouncements(state.timeLeft);
          }
        }
      }
      tickTimeoutId = setTimeout(tick, 50);
    }

    // --- 7. Canvas 绘制渲染模块 ---
    function resize() {
      const rect = canvas.parentNode.getBoundingClientRect();
      canvas.width = rect.width * scale;
      canvas.height = rect.height * scale;
      ctx.scale(scale, scale);
      draw();
    }

    function drawRoundedRect(ctx, x, y, width, height, r, fill, stroke, strokeColor, lWidth) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      if (fill) ctx.fill();
      if (stroke) {
        ctx.strokeStyle = strokeColor || '#fff';
        ctx.lineWidth = lWidth || 1;
        ctx.stroke();
      }
    }

    let hitboxes = [];

    function draw() {
      const w = canvas.width / scale;
      const h = canvas.height / scale;
      hitboxes = [];

      let targetColor = backgroundColors.config;
      if (state.status === 'training') {
        targetColor = backgroundColors[state.subStatus];
      }
      currentBg.r += (targetColor.r - currentBg.r) * 0.1;
      currentBg.g += (targetColor.g - currentBg.g) * 0.1;
      currentBg.b += (targetColor.b - currentBg.b) * 0.1;

      ctx.fillStyle = `rgb(${Math.round(currentBg.r)}, ${Math.round(currentBg.g)}, ${Math.round(currentBg.b)})`;
      ctx.fillRect(0, 0, w, h);

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x += 1;
        if (p.x > 1) p.x -= 1;
        if (p.y < 0) p.y += 1;
        if (p.y > 1) p.y -= 1;

        ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, p.size, 0, Math.PI * 2);
        ctx.fill();
      });

      if (state.status === 'config') {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f97316';
        ctx.font = '900 32px sans-serif';
        ctx.fillText('PLANK RHYTHM', w / 2, h * 0.08);

        ctx.fillStyle = '#64748b';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText('专注节奏 · 高效核心训练', w / 2, h * 0.11);

        const controls = [
          { id: 'work', title: '🔥 单组支撑时长', val: config.workTime, unit: '秒', step: 5, color: '#f97316' },
          { id: 'rest', title: '🔄 组间休整间隔', val: config.restTime, unit: '秒', step: 5, color: '#38bdf8' },
          { id: 'rounds', title: '📦 循环目标组数', val: config.totalRounds, unit: '组', step: 1, color: '#34d399' }
        ];

        const cardStartY = h * 0.16;
        const cardGap = h * 0.18;
        const cardHeight = h * 0.15;

        controls.forEach((ctrl, i) => {
          const y = cardStartY + i * cardGap;
          ctx.fillStyle = '#0f172a';
          drawRoundedRect(ctx, 24, y, w - 48, cardHeight, 18, true, true, '#1e293b', 1.5);

          ctx.textAlign = 'left';
          ctx.fillStyle = '#94a3b8';
          ctx.font = 'bold 14px sans-serif';
          ctx.fillText(ctrl.title, 44, y + 26);

          ctx.textAlign = 'center';
          ctx.fillStyle = ctrl.color;
          ctx.font = '900 38px sans-serif';
          ctx.fillText(ctrl.val, w / 2, y + 68);
          ctx.font = 'bold 14px sans-serif';
          ctx.fillStyle = '#64748b';
          ctx.fillText(ctrl.unit, w / 2 + 35, y + 68);

          const btnSize = 44;
          const btnY = y + cardHeight / 2 - btnSize / 2 + 5;

          ctx.fillStyle = clickFeedback[`${ctrl.id}_dec`] ? '#334155' : '#1e293b';
          drawRoundedRect(ctx, 44, btnY, btnSize, btnSize, 12, true, true, '#475569', 1.5);
          ctx.fillStyle = '#f1f5f9';
          ctx.font = 'bold 20px sans-serif';
          ctx.fillText('-', 44 + btnSize / 2, btnY + btnSize / 2 + 7);
          hitboxes.push({ x: 44, y: btnY, w: btnSize, h: btnSize, action: 'dec_' + ctrl.id });

          ctx.fillStyle = clickFeedback[`${ctrl.id}_inc`] ? '#334155' : '#1e293b';
          drawRoundedRect(ctx, w - 44 - btnSize, btnY, btnSize, btnSize, 12, true, true, '#475569', 1.5);
          ctx.fillStyle = '#f1f5f9';
          ctx.fillText('+', w - 44 - btnSize / 2, btnY + btnSize / 2 + 7);
          hitboxes.push({ x: w - 44 - btnSize, y: btnY, w: btnSize, h: btnSize, action: 'inc_' + ctrl.id });
        });

        const voiceY = cardStartY + 3 * cardGap - 10;
        ctx.fillStyle = '#0f172a';
        drawRoundedRect(ctx, 24, voiceY, w - 48, h * 0.08, 14, true, true, '#1e293b', 1.5);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#cbd5e1';
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText('🔊 提示音', 40, voiceY + h * 0.048);

        ctx.textAlign = 'right';
        ctx.fillStyle = soundEnabled ? '#34d399' : '#64748b';
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(soundEnabled ? '已开启 ⇆' : '已关闭 ⇆', w - 40, voiceY + h * 0.048);
        hitboxes.push({ x: 24, y: voiceY, w: w - 48, h: h * 0.08, action: 'toggle_sound' });

        const footerY = h - 94;
        const testBtnW = 100;

        ctx.fillStyle = clickFeedback['test_voice'] ? '#1e293b' : '#0f172a';
        drawRoundedRect(ctx, 24, footerY, testBtnW, 60, 16, true, true, '#334155', 1.5);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#cbd5e1';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText('测试声音', 24 + testBtnW / 2, footerY + 34);
        hitboxes.push({ x: 24, y: footerY, w: testBtnW, h: 60, action: 'test_voice' });

        ctx.fillStyle = clickFeedback['start'] ? '#ea580c' : '#f97316';
        drawRoundedRect(ctx, 24 + testBtnW + 12, footerY, w - 48 - testBtnW - 12, 60, 16, true, false);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText('进入训练', 24 + testBtnW + 12 + (w - 48 - testBtnW - 12) / 2, footerY + 36);
        hitboxes.push({ x: 24 + testBtnW + 12, y: footerY, w: w - 48 - testBtnW - 12, h: 60, action: 'start' });

      } else {
        let subTitles = { prepare: 'PREPARE', work: 'HOLD THE PLANK', rest: 'BREATHE & REST' };
        let chineseStatus = { prepare: '准备开始', work: '保持动作中', rest: '舒缓呼吸中' };

        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.font = '900 16px sans-serif';
        ctx.fillText(subTitles[state.subStatus], 28, h * 0.06);

        ctx.textAlign = 'right';
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 16px sans-serif';
        ctx.fillText(`第 ${state.currentRound} / ${config.totalRounds} 组`, w - 28, h * 0.06);

        progressRing += (targetRing - progressRing) * 0.15;

        const cx = w / 2;
        const cy = h * 0.42;
        const r = Math.min(w * 0.35, 140);

        ctx.save();
        ctx.shadowBlur = 30;
        ctx.shadowColor = 'rgba(255,255,255,0.15)';
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 14;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 14;
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * progressRing), false);
        ctx.stroke();
        ctx.restore();

        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 96px sans-serif';
        ctx.fillText(state.timeLeft, cx, cy + 32);

        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText(chineseStatus[state.subStatus], cx, cy + r + 50);

        const ctrlY = h - 94;
        const pauseW = w * 0.6;

        ctx.fillStyle = clickFeedback['pause'] ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.25)';
        drawRoundedRect(ctx, 24, ctrlY, pauseW, 60, 16, true, true, 'rgba(255,255,255,0.4)', 1.5);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText(state.isPaused ? '继续' : '暂停', 24 + pauseW / 2, ctrlY + 36);
        hitboxes.push({ x: 24, y: ctrlY, w: pauseW, h: 60, action: 'pause' });

        ctx.fillStyle = clickFeedback['stop'] ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.15)';
        drawRoundedRect(ctx, 24 + pauseW + 12, ctrlY, w - 48 - pauseW - 12, 60, 16, true, true, 'rgba(255,255,255,0.2)', 1.5);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('终止', 24 + pauseW + 12 + (w - 48 - pauseW - 12) / 2, ctrlY + 36);
        hitboxes.push({ x: 24 + pauseW + 12, y: ctrlY, w: w - 48 - pauseW - 12, h: 60, action: 'stop' });
      }
    }

    function getCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return {
        x: (clientX - rect.left) * (canvas.width / rect.width) / scale,
        y: (clientY - rect.top) * (canvas.height / rect.height) / scale
      };
    }

    function handleDown(e) {
      unlockAudio();   // iOS 关键：任何触摸都激活音频通道
      const pos = getCoords(e);
      hitboxes.forEach(box => {
        if (pos.x >= box.x && pos.x <= box.x + box.w && pos.y >= box.y && pos.y <= box.y + box.h) {
          clickFeedback[box.action] = true;
          if (box.action.startsWith('dec_') || box.action.startsWith('inc_')) {
            const targetField = box.action.split('_')[1];
            const stepSign = box.action.startsWith('dec_') ? -1 : 1;

            if (targetField === 'work') {
              config.workTime = Math.max(5, config.workTime + stepSign * 5);
            } else if (targetField === 'rest') {
              config.restTime = Math.max(5, config.restTime + stepSign * 5);
            } else if (targetField === 'rounds') {
              config.totalRounds = Math.max(1, config.totalRounds + stepSign);
            }
            saveConfig();
            cue('tick');   // 调整时给个轻反馈音
          } else if (box.action === 'toggle_sound') {
            soundEnabled = !soundEnabled;
            localStorage.setItem('plank_sound', soundEnabled ? 'on' : 'off');
            if (soundEnabled) cue('ready');
          } else if (box.action === 'test_voice') {
            cue('test');
          } else if (box.action === 'start') {
            startTraining();
          } else if (box.action === 'pause') {
            togglePause();
          } else if (box.action === 'stop') {
            resetTraining();
          }
        }
      });
      draw();
    }

    function handleUp() {
      clickFeedback = {};
      draw();
    }

    canvas.addEventListener('mousedown', handleDown);
    const touchStartHandler = (e) => {
      e.preventDefault();
      handleDown(e);
    };
    canvas.addEventListener('touchstart', touchStartHandler, { passive: false });

    window.addEventListener('mouseup', handleUp);
    window.addEventListener('touchend', handleUp);
    window.addEventListener('resize', resize);

    let animationFrameId;
    function frame() {
      draw();
      animationFrameId = requestAnimationFrame(frame);
    }

    resize();
    frame();

    return () => {
      canvas.removeEventListener('mousedown', handleDown);
      canvas.removeEventListener('touchstart', touchStartHandler);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchend', handleUp);
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrameId);
      if (tickTimeoutId) clearTimeout(tickTimeoutId);
      releaseWakeLock();
    };
  }, []);

  return <canvas ref={canvasRef} className="w-full h-full block" />;
}
