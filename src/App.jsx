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
    // --- 2. 音频引擎（移植自节拍器：内存合成 WAV + 原生 <audio> 播放）---
    // ============================================================
    // 原理：在内存里逐采样合成一段悦耳的"木鱼/电子敲击"短音，封装成 WAV，
    // 用原生 Audio 播放。走媒体音量通道，iOS 上又响又不刺耳。
    // 音色算法直接采用节拍器的 synthesizeTickToBuffer（正弦+快速衰减+tanh软饱和）。

    function writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    // 合成一个敲击音到声道数据。pitch 控制音高(用于区分报数/提示)，vol 控制响度。
    function synthTone(channelData, sampleRate, startIndex, opts) {
      const { type = 'wood', pitch = 1.0, vol = 1.0, dur = 0.08 } = opts;
      const numSamples = Math.floor(dur * sampleRate);

      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        let sample = 0;

        if (type === 'wood') {
          // 木鱼：高频正弦 + 极快衰减，清脆温润
          const amp = Math.exp(-t / 0.012) * 0.9 * vol;
          const freq = 1500 * pitch;
          sample = Math.tanh(Math.sin(2 * Math.PI * freq * t) * amp);
        } else {
          // 电子：指数扫频 + 1.58倍非谐和泛音 + tanh软饱和，模拟木质空腔共鸣
          const amp = Math.exp(-t / 0.018) * 0.95 * vol;
          const fStart = 780 * pitch;
          const fEnd = 170 * pitch;
          const tau_f = 0.014;
          const phase = 2 * Math.PI * (fEnd * t - (fStart - fEnd) * tau_f * (Math.exp(-t / tau_f) - 1));
          const fundamental = Math.sin(phase);
          const resonance = Math.sin(phase * 1.58);
          sample = Math.tanh((fundamental + 0.18 * resonance) * amp);
        }
        // 叠加（允许一个 WAV 里前后排多个敲击）
        channelData[startIndex + i] = Math.tanh((channelData[startIndex + i] || 0) + sample);
      }
    }

    // 把一组敲击合成为一个 WAV Blob 的 URL。hits = [{type,pitch,vol,dur,at}]
    function buildWavUrl(hits) {
      const sampleRate = 22050;
      let totalDur = 0;
      hits.forEach(h => { totalDur = Math.max(totalDur, (h.at || 0) + (h.dur || 0.08)); });
      totalDur += 0.05;
      const totalSamples = Math.floor(totalDur * sampleRate);

      const buffer = new ArrayBuffer(44 + totalSamples * 2);
      const view = new DataView(buffer);
      writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + totalSamples * 2, true);
      writeString(view, 8, 'WAVE');
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(view, 36, 'data');
      view.setUint32(40, totalSamples * 2, true);

      const channelData = new Float32Array(totalSamples);
      hits.forEach(h => {
        const startIndex = Math.floor((h.at || 0) * sampleRate);
        synthTone(channelData, sampleRate, startIndex, h);
      });

      let offset = 44;
      for (let i = 0; i < totalSamples; i++) {
        const s = channelData[i];
        const pcm = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(offset, pcm, true);
        offset += 2;
      }
      return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    }

    // 预生成每种提示音的 WAV（启动时合成一次，之后秒播）
    const soundUrls = {};
    function buildAllSounds() {
      if (soundUrls.ready) return; // 已生成
      // 倒数报数：清脆木鱼，音高随数字略变化更有节奏层次
      soundUrls['count'] = buildWavUrl([{ type: 'wood', pitch: 1.0, vol: 1.0, dur: 0.07 }]);
      soundUrls['tick']  = buildWavUrl([{ type: 'wood', pitch: 0.8, vol: 0.6, dur: 0.05 }]);
      // 开始：上扬双击（电子音）
      soundUrls['start'] = buildWavUrl([
        { type: 'electronic', pitch: 0.9, vol: 1.0, dur: 0.09, at: 0 },
        { type: 'electronic', pitch: 1.3, vol: 1.0, dur: 0.10, at: 0.11 }
      ]);
      // 休息：下行双击
      soundUrls['rest'] = buildWavUrl([
        { type: 'electronic', pitch: 1.2, vol: 1.0, dur: 0.09, at: 0 },
        { type: 'electronic', pitch: 0.8, vol: 1.0, dur: 0.11, at: 0.11 }
      ]);
      // 准备：单声清亮木鱼
      soundUrls['ready'] = buildWavUrl([{ type: 'wood', pitch: 1.2, vol: 1.0, dur: 0.08 }]);
      // 完成：三连上扬庆祝音
      soundUrls['complete'] = buildWavUrl([
        { type: 'electronic', pitch: 1.0, vol: 1.0, dur: 0.10, at: 0 },
        { type: 'electronic', pitch: 1.3, vol: 1.0, dur: 0.10, at: 0.13 },
        { type: 'electronic', pitch: 1.7, vol: 1.0, dur: 0.20, at: 0.26 }
      ]);
      soundUrls['pause'] = buildWavUrl([{ type: 'electronic', pitch: 0.7, vol: 0.8, dur: 0.10 }]);
      soundUrls['resume'] = buildWavUrl([{ type: 'electronic', pitch: 1.1, vol: 0.8, dur: 0.10 }]);
    }

    // 复用一个原生 Audio 对象池播放（iOS 上原生 audio 走媒体音量、稳定且响）
    const audioPool = [];
    let poolIndex = 0;
    function getAudio() {
      if (audioPool.length < 4) {
        const a = new Audio();
        audioPool.push(a);
        return a;
      }
      poolIndex = (poolIndex + 1) % 4;
      return audioPool[poolIndex];
    }

    function playSound(name) {
      const url = soundUrls[name];
      if (!url) return;
      const a = getAudio();
      a.src = url;
      a.currentTime = 0;
      a.volume = 1.0;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    }

    // 音频解锁：首次用户手势里合成所有音 + 播一个静音激活媒体通道
    let audioReady = false;
    function unlockAudio() {
      if (audioReady) return;
      buildAllSounds();
      // 播放一次极短静音，激活 iOS 媒体音频通道
      const a = getAudio();
      a.src = soundUrls['tick'];
      a.volume = 0.01;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
      audioReady = true;
    }

    // ============================================================
    // --- 3. 统一发声入口 cue() ---
    // ============================================================
    function cue(key) {
      if (!soundEnabled) return;
      if (!audioReady) buildAllSounds();

      if (['1', '2', '3', '4', '5'].includes(key)) {
        playSound('count');
        return;
      }
      switch (key) {
        case 'start': playSound('start'); break;
        case 'rest': playSound('rest'); break;
        case 'ready': playSound('ready'); break;
        case 'complete': playSound('complete'); break;
        case 'pause': playSound('pause'); break;
        case 'resume': playSound('resume'); break;
        case 'tick': playSound('tick'); break;
        case 'test':
          playSound('ready');
          setTimeout(() => playSound('start'), 300);
          setTimeout(() => playSound('complete'), 650);
          break;
        default: playSound('count');
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
