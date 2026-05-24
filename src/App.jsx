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

    // 语音播报及双通道词典
    let filteredVoices = [];
    let selectedVoiceIndex = 0;
    let audioUnlocked = false;
    let wakeLock = null;

    const speechPhrases = {
      zh: {
        prepareIntro: "准备，五，四，三，二，一",
        start: "开始",
        rest: "休息",
        ready: "准备",
        resume: "继续",
        pause: "暂停",
        complete: "训练完成，干得漂亮！",
        test: "平板支撑计时，系统就绪！"
      },
      en: {
        prepareIntro: "Get ready, five, four, three, two, one",
        start: "Start",
        rest: "Rest",
        ready: "Ready",
        resume: "Resume",
        pause: "Pause",
        complete: "Workout complete, fantastic job!",
        test: "Plank rhythm timer, system ready!"
      }
    };

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

    // --- 2. 语音选择及多语种适配 ---
    let diag = { total: 0, zhList: '?', hk: '?', en: '?', spoke: 0 };

    function initVoices() {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        const allVoices = window.speechSynthesis.getVoices();
        
        // 中文语音检索：iOS 上 zh-CN/zh-TW 几乎必定可用且开箱即响，
        // 而 zh-HK 粤语包常常未预装、选中也不出声，故把它放到最后。
        const zhVoices = allVoices.filter(v => v.lang.toLowerCase().replace('_', '-').includes('zh'));
        let hkVoice =
          zhVoices.find(v => {
            const l = v.lang.toLowerCase().replace('_', '-');
            return l.includes('zh-cn') || l.includes('cmn');
          }) ||
          zhVoices.find(v => v.lang.toLowerCase().replace('_', '-').includes('zh-tw')) ||
          zhVoices.find(v => {
            const l = v.lang.toLowerCase().replace('_', '-');
            return l.includes('zh-hk') || l.includes('zh-yue');
          }) ||
          zhVoices[0] ||
          null;

        // 英语女声检索
        const femaleNames = ['samantha', 'victoria', 'hazel', 'zira', 'susan', 'karen', 'moira', 'tessa', 'female', 'google us english', 'microsoft zira'];
        let enVoice = allVoices.find(v => {
          const lang = v.lang.toLowerCase();
          const name = v.name.toLowerCase();
          return lang.startsWith('en') && femaleNames.some(fn => name.includes(fn));
        });
        if (!enVoice) {
          enVoice = allVoices.find(v => v.lang.toLowerCase().startsWith('en'));
        }

        filteredVoices = [
          { voice: hkVoice || null, label: hkVoice ? "中文女声" : "中文女声 (缺省)", type: 'zh' },
          { voice: enVoice || null, label: enVoice ? "英语女声" : "英语女声 (缺省)", type: 'en' }
        ];

        // 诊断信息收集
        diag.total = allVoices.length;
        diag.zhList = allVoices.filter(v => v.lang.toLowerCase().includes('zh')).map(v => v.lang).join(',') || '无';
        diag.hk = hkVoice ? hkVoice.name + '/' + hkVoice.lang : 'null';
        diag.en = enVoice ? enVoice.name + '/' + enVoice.lang : 'null';
      } else {
        diag.total = -1; // speechSynthesis 不存在
      }
    }
    
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = initVoices;
      initVoices();
    }

    function speak(phraseKey) {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        
        const activeOption = filteredVoices[selectedVoiceIndex];
        if (!activeOption) return;

        let phrase = "";
        if (speechPhrases[activeOption.type][phraseKey]) {
          phrase = speechPhrases[activeOption.type][phraseKey];
        } else {
          phrase = phraseKey; 
        }

        const utterance = new SpeechSynthesisUtterance(phrase);
        if (activeOption.voice) {
          utterance.voice = activeOption.voice;
          utterance.lang = activeOption.voice.lang;
        } else {
          utterance.lang = activeOption.type === 'zh' ? 'zh-CN' : 'en-US';
        }

        utterance.volume = 1;
        utterance.pitch = 1;
        utterance.rate = activeOption.type === 'zh' ? 1.2 : 1.1;
        window.speechSynthesis.speak(utterance);
        diag.spoke++;
      }
    }

    // iOS Safari 音频解锁：必须在真实用户手势中、念真实内容才能生效
    function unlockAudio() {
      if (audioUnlocked) return;
      if (typeof window === 'undefined' || !window.speechSynthesis) return;

      // 若语音列表还没加载完，先补一次
      if (filteredVoices.length === 0) initVoices();

      // iOS 不认空字符串，用一个几乎听不见的真实短词来解锁通道
      const warm = new SpeechSynthesisUtterance('.');
      warm.volume = 0.01;
      warm.rate = 2;
      const activeOption = filteredVoices[selectedVoiceIndex];
      if (activeOption && activeOption.voice) {
        warm.voice = activeOption.voice;
        warm.lang = activeOption.voice.lang;
      }
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(warm);
      audioUnlocked = true;
    }

    // --- 3. Wake Lock 唤醒锁 ---
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
        wakeLock.release().then(() => wakeLock = null);
      }
    }

    // --- 4. 存储配置 ---
    function saveConfig() {
      localStorage.setItem('plank_work_time', config.workTime);
      localStorage.setItem('plank_rest_time', config.restTime);
      localStorage.setItem('plank_total_rounds', config.totalRounds);
    }

    // --- 5. 绝对物理时钟计时器 ---
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

      speak("prepareIntro");
      tick();
    }

    function togglePause() {
      if (state.isPaused) {
        targetEndTime = Date.now() + pausedRemainingTime;
        state.isPaused = false;
        speak("resume");
      } else {
        pausedRemainingTime = targetEndTime - Date.now();
        state.isPaused = true;
        speak("pause");
      }
    }

    function resetTraining() {
      state.status = 'config';
      releaseWakeLock();
      window.speechSynthesis.cancel();
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
        speak("start");
      } else if (state.subStatus === 'work') {
        if (state.currentRound >= config.totalRounds) {
          speak("complete");
          resetTraining();
        } else {
          state.subStatus = 'rest';
          state.timeLeft = config.restTime;
          phaseDuration = config.restTime;
          targetEndTime = Date.now() + (config.restTime * 1000);
          lastSpokenSec = -1;
          speak("rest");
        }
      } else if (state.subStatus === 'rest') {
        state.currentRound++;
        state.subStatus = 'work';
        state.timeLeft = config.workTime;
        phaseDuration = config.workTime;
        targetEndTime = Date.now() + (config.workTime * 1000);
        lastSpokenSec = -1;
        speak("start");
      }
    }

    function triggerVoiceAnnouncements(sec) {
      if (state.subStatus === 'prepare') {
        if (sec <= 4 && sec >= 1) {
          speak(sec.toString());
        }
      } else if (state.subStatus === 'work') {
        if (sec <= 5 && sec >= 1) {
          speak(sec.toString());
        }
      } else if (state.subStatus === 'rest') {
        if (sec === 5) {
          speak("ready");
        } else if (sec < 5 && sec >= 1) {
          speak(sec.toString());
        }
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

    // --- 6. Canvas 绘制渲染模块 ---
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

        // === 诊断面板（排查完可删除）===
        ctx.textAlign = 'center';
        ctx.font = 'bold 11px monospace';
        ctx.fillStyle = diag.total > 0 ? '#34d399' : '#f87171';
        ctx.fillText(`语音数:${diag.total} | 已播:${diag.spoke}`, w / 2, h * 0.135);
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(`zh: ${diag.zhList}`, w / 2, h * 0.152);
        ctx.fillText(`HK: ${diag.hk}`, w / 2, h * 0.169);
        ctx.fillText(`EN: ${diag.en}`, w / 2, h * 0.186);
        // === 诊断面板结束 ===

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
        ctx.fillText('🗣️ 提示语音选择', 40, voiceY + h * 0.048);

        ctx.textAlign = 'right';
        ctx.fillStyle = '#f97316';
        let activeVoiceName = filteredVoices[selectedVoiceIndex] ? filteredVoices[selectedVoiceIndex].label : '粤语女声';
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(activeVoiceName + ' ⇆', w - 40, voiceY + h * 0.048);
        hitboxes.push({ x: 24, y: voiceY, w: w - 48, h: h * 0.08, action: 'toggle_voice' });

        const footerY = h - 94;
        const testBtnW = 100;
        
        ctx.fillStyle = clickFeedback['test_sound'] ? '#1e293b' : '#0f172a';
        drawRoundedRect(ctx, 24, footerY, testBtnW, 60, 16, true, true, '#334155', 1.5);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#cbd5e1';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText('测试语音', 24 + testBtnW/2, footerY + 34);
        hitboxes.push({ x: 24, y: footerY, w: testBtnW, h: 60, action: 'test_voice' });

        ctx.fillStyle = clickFeedback['start'] ? '#ea580c' : '#f97316';
        drawRoundedRect(ctx, 24 + testBtnW + 12, footerY, w - 48 - testBtnW - 12, 60, 16, true, false);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText('进入训练', 24 + testBtnW + 12 + (w - 48 - testBtnW - 12)/2, footerY + 36);
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
        ctx.fillText(state.isPaused ? '继续' : '暂停', 24 + pauseW/2, ctrlY + 36);
        hitboxes.push({ x: 24, y: ctrlY, w: pauseW, h: 60, action: 'pause' });

        ctx.fillStyle = clickFeedback['stop'] ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.15)';
        drawRoundedRect(ctx, 24 + pauseW + 12, ctrlY, w - 48 - pauseW - 12, 60, 16, true, true, 'rgba(255,255,255,0.2)', 1.5);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('终止', 24 + pauseW + 12 + (w - 48 - pauseW - 12)/2, ctrlY + 36);
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

    const fieldMapping = {
      work: 'workTime',
      rest: 'restTime',
      rounds: 'totalRounds'
    };

    function handleDown(e) {
      unlockAudio();
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
            
            const resolvedKey = fieldMapping[targetField];
            if (resolvedKey && config[resolvedKey] !== undefined) {
              speak(config[resolvedKey].toString());
            }
          } else if (box.action === 'toggle_voice') {
            if (filteredVoices.length > 0) {
              selectedVoiceIndex = (selectedVoiceIndex + 1) % filteredVoices.length;
              speak("test");
            }
          } else if (box.action === 'test_voice') {
            speak("test");
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
