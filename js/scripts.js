// OPTIMIZED JAVASCRIPT - Performance improvements and time-bound sessions

let currentTechnique = '478';
let isBreathing = false;
let isPaused = false;
let currentPhase = 0;
let phaseTimer = 0;
let totalTimer = 0;
let breathingInterval;
let timerInterval;
let animationInterval;
let breathCount = 0;
let breathStartTime = 0;
let totalBreathTime = 0;
let phaseStartTime = 0;
let currentPhaseProgress = 0;

// Session management
let sessionDuration = 600;
let sessionStartTime = 0;
let sessionTimer = 0;
let sessionInterval;

// Settings
let soundEnabled = true;
let vibrationEnabled = true;

// Audio system
class OptimizedAudioSystem {
    constructor() {
        this.audioContext = null;
        this.isInitialized = false;
        this.masterGain = null;
        this.isSupported = this.checkAudioSupport();
        this.activeNodes = new Set();
    }

    checkAudioSupport() {
        return !!(window.AudioContext || window.webkitAudioContext);
    }

    async init() {
        if (!this.isSupported || this.isInitialized) return;
        
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.setValueAtTime(0.3, this.audioContext.currentTime);
            this.masterGain.connect(this.audioContext.destination);
            this.isInitialized = true;
        } catch (error) {
            console.warn('Audio initialization failed:', error);
            this.isSupported = false;
        }
    }

    createBreathSound(frequency, duration, type = 'inhale') {
        if (!this.isSupported || !soundEnabled || !this.isInitialized) return;

        const now = this.audioContext.currentTime;
        const endTime = now + duration;

        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(frequency, now);
        
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(frequency * 2, now);

        if (type === 'inhale') {
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.15, now + duration * 0.7);
            gain.gain.linearRampToValueAtTime(0, endTime);
        } else if (type === 'exhale') {
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.12, now + 0.2);
            gain.gain.exponentialRampToValueAtTime(0.01, endTime);
        } else {
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.05, now + 1);
            gain.gain.setValueAtTime(0.05, endTime - 1);
            gain.gain.linearRampToValueAtTime(0, endTime);
        }

        osc.connect(gain);
        gain.connect(filter);
        filter.connect(this.masterGain);

        osc.start(now);
        osc.stop(endTime);

        this.activeNodes.add({ endTime, nodes: [osc] });
        
        setTimeout(() => {
            this.cleanup();
        }, duration * 1000 + 100);
    }

    cleanup() {
        const now = this.audioContext ? this.audioContext.currentTime : 0;
        for (const node of this.activeNodes) {
            if (node.endTime < now - 1) {
                this.activeNodes.delete(node);
            }
        }
    }

    stop() {
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }
        this.activeNodes.clear();
        this.isInitialized = false;
        this.audioContext = null;
    }
}

const audioSystem = new OptimizedAudioSystem();

const techniques = {
    '478': {
        name: '🌙 Deep Sleep',
        title: 'Deep Sleep & Relaxation',
        theme: 'theme-478',
        circleClass: 'technique-478',
        phases: [
            { name: 'Inhale', duration: 4, class: 'inhale', text: 'Breathe in slowly, filling with moonlight...', frequency: 174.61 },
            { name: 'Hold', duration: 7, class: 'hold', text: 'Hold gently, let the calm settle in...', frequency: 0 },
            { name: 'Exhale', duration: 8, class: 'exhale', text: 'Release completely, drift into peace...', frequency: 130.81 }
        ],
        description: 'The 4-7-8 breathing technique helps activate your parasympathetic nervous system, promoting deep relaxation and better sleep. Like the gentle phases of the moon, this practice guides you into peaceful rest.'
    },
    'box': {
        name: '🌿 Focus & Grounding',
        title: 'Earth Connection & Mental Clarity',
        theme: 'theme-box',
        circleClass: 'technique-box',
        phases: [
            { name: 'Inhale', duration: 4, class: 'inhale', text: 'Draw in earth\'s grounding energy...', frequency: 146.83 },
            { name: 'Hold', duration: 4, class: 'hold', text: 'Feel rooted and centered...', frequency: 0 },
            { name: 'Exhale', duration: 4, class: 'exhale', text: 'Release with steady control...', frequency: 110 },
            { name: 'Hold', duration: 4, class: 'hold', text: 'Rest in perfect stillness...', frequency: 0 }
        ],
        description: 'Box breathing connects you to the earth\'s stable energy. Like a tree with deep roots, find unshakeable focus and mental clarity through this grounding practice.'
    },
    'coherent': {
        name: '💗 Heart Coherence',
        title: 'Heart Rhythm & Emotional Flow',
        theme: 'theme-coherent',
        circleClass: 'technique-coherent',
        phases: [
            { name: 'Inhale', duration: 5, class: 'inhale', text: 'Breathe love into your heart...', frequency: 220 },
            { name: 'Exhale', duration: 5, class: 'exhale', text: 'Send gratitude flowing outward...', frequency: 164.81 }
        ],
        description: 'Heart coherence breathing creates a harmonious flow between mind and heart. Like gentle waves, this rhythm reduces stress and opens you to deeper emotional balance.'
    },
    'triangle': {
        name: '☁️ Quick Calm',
        title: 'Sky Breath & Instant Peace',
        theme: 'theme-triangle',
        circleClass: 'technique-triangle',
        phases: [
            { name: 'Inhale', duration: 3, class: 'inhale', text: 'Breathe in fresh clarity...', frequency: 261.63 },
            { name: 'Hold', duration: 3, class: 'hold', text: 'Float in peaceful pause...', frequency: 0 },
            { name: 'Exhale', duration: 3, class: 'exhale', text: 'Let go like a soft breeze...', frequency: 196 }
        ],
        description: 'Quick and balancing, this technique brings the lightness of clouds and sky. Perfect for busy moments when you need instant calm and mental clarity.'
    },
    'wim': {
        name: '☀️ Energy Boost',
        title: 'Solar Power & Vitality',
        theme: 'theme-wim',
        circleClass: 'technique-wim',
        phases: [
            { name: 'Inhale', duration: 2, class: 'inhale', text: 'Draw in solar energy...', frequency: 329.63 },
            { name: 'Exhale', duration: 1, class: 'exhale', text: 'Release with power...', frequency: 246.94 }
        ],
        description: 'Channel the sun\'s vibrant energy through this dynamic breathing practice. Awaken your inner fire, boost alertness, and enhance your natural vitality.'
    }
};

function safeGetElement(id) {
    const element = document.getElementById(id);
    if (!element) {
        console.warn(`Element not found: ${id}`);
    }
    return element;
}

function playBreathingSound(frequency, duration) {
    if (!soundEnabled) return;
    
    try {
        const technique = techniques[currentTechnique];
        const phase = technique.phases[currentPhase];
        
        audioSystem.createBreathSound(frequency, duration, phase.name.toLowerCase());
        
    } catch (e) {
        console.warn('Audio error:', e);
    }
}

function vibrate(pattern) {
    if (!vibrationEnabled || !navigator.vibrate) return;
    try {
        navigator.vibrate(pattern);
    } catch (e) {
        console.warn('Vibration error:', e);
    }
}

function getSessionDuration() {
    const select = safeGetElement('sessionDuration');
    return select ? parseInt(select.value) : 600;
}

function updateSessionProgress() {
    if (sessionDuration === -1) return;
    
    const elapsed = Date.now() - sessionStartTime;
    const progress = Math.min((elapsed / 1000) / sessionDuration, 1);
    const remaining = Math.max(sessionDuration - (elapsed / 1000), 0);
    
    const progressFill = safeGetElement('sessionProgressFill');
    const timeRemaining = safeGetElement('sessionTimeRemaining');
    
    if (progressFill) {
        progressFill.style.width = `${progress * 100}%`;
    }
    
    if (timeRemaining) {
        const minutes = Math.floor(remaining / 60);
        const seconds = Math.floor(remaining % 60);
        timeRemaining.textContent = `${minutes}:${seconds.toString().padStart(2, '0')} remaining`;
    }
    
    if (progress >= 1 && isBreathing) {
        stopBreathing();
        showSessionComplete();
    }
}

function showSessionComplete() {
    const breathingText = safeGetElement('breathingText');
    if (breathingText) {
        breathingText.textContent = '🎉 Session complete! Well done.';
    }
    
    if (typeof gtag !== 'undefined') {
        gtag('event', 'session_complete', {
            'event_category': 'breathing',
            'event_label': currentTechnique,
            'value': Math.floor(sessionDuration / 60)
        });
    }
    
    vibrate([200, 100, 200, 100, 200]);
}

function setupToggle(toggleId, callback) {
    const toggle = safeGetElement(toggleId);
    if (!toggle) return;
    
    const handleToggle = () => {
        toggle.classList.toggle('active');
        if (callback) callback(toggle.classList.contains('active'));
    };
    
    toggle.addEventListener('click', handleToggle);
    toggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
        }
    });
}

function initializeSettings() {
    const settingsBtn = safeGetElement('settingsBtn');
    const settingsPanel = safeGetElement('settingsPanel');
    
    if (!settingsBtn || !settingsPanel) return;
    
    settingsBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        settingsPanel.classList.toggle('show');
    });

    document.addEventListener('click', function(e) {
        if (!settingsBtn.contains(e.target) && !settingsPanel.contains(e.target)) {
            settingsPanel.classList.remove('show');
        }
    });

    setupToggle('soundToggle', (enabled) => {
        soundEnabled = enabled;
        if (enabled) {
            audioSystem.init();
        }
    });

    setupToggle('vibrationToggle', (enabled) => {
        vibrationEnabled = enabled;
    });

    const sessionSelect = safeGetElement('sessionDuration');
    if (sessionSelect) {
        sessionSelect.addEventListener('change', function() {
            sessionDuration = getSessionDuration();
            
            const sessionInfo = safeGetElement('sessionInfo');
            if (sessionInfo) {
                if (sessionDuration === -1) {
                    sessionInfo.style.display = 'none';
                } else {
                    sessionInfo.style.display = 'block';
                    updateSessionProgress();
                }
            }
        });
    }
}

function selectTechnique(techniqueKey) {
    if (isBreathing) {
        stopBreathing();
    }

    currentTechnique = techniqueKey;
    const technique = techniques[techniqueKey];
    
    if (!technique) {
        console.error('Technique not found:', techniqueKey);
        return;
    }
    
    document.body.style.transition = 'background 1s cubic-bezier(0.4, 0, 0.2, 1)';
    document.body.className = technique.theme;
    
    requestAnimationFrame(() => {
        const techniqueTitle = safeGetElement('technique-title');
        if (techniqueTitle) {
            techniqueTitle.textContent = technique.name;
        }
        
        const techniqueInfo = safeGetElement('techniqueInfo');
        if (techniqueInfo) {
            techniqueInfo.innerHTML = `
                <h3>${technique.title}</h3>
                <p>${technique.description}</p>
            `;
        }
       const circle = safeGetElement('breathingCircle');
if (circle) {
    // Remove any existing classes and animations
    circle.classList.remove('active', 'technique-478', 'technique-box', 'technique-coherent', 'technique-triangle', 'technique-wim');
    
    // Add the correct technique class
    circle.className = `breathing-circle ${technique.circleClass}`;
    
    // Force animation reset
    circle.style.animation = 'none';
    circle.offsetHeight; // Trigger reflow
    circle.style.animation = '';
}
        const progressFill = safeGetElement('progressFill');
        if (progressFill) {
            progressFill.style.width = '0%';
        }
        
        const progressTime = safeGetElement('progressTime');
        if (progressTime) {
            progressTime.textContent = '';
        }
        
        updateActiveButton(techniqueKey);
        
        const circleText = safeGetElement('circleText');
        if (circleText) {
            circleText.textContent = 'Ready';
        }
        
        const breathingText = safeGetElement('breathingText');
        if (breathingText) {
            breathingText.textContent = 'Click Begin to start your practice';
        }
    });
}

function updateActiveButton(techniqueKey) {
    document.querySelectorAll('.technique-btn').forEach(btn => btn.classList.remove('active'));
    
    const techniqueNames = {
        '478': '🌙 Deep Sleep',
        'box': '🌿 Focus & Grounding',
        'coherent': '💗 Heart Coherence',
        'triangle': '☁️ Quick Calm',
        'wim': '☀️ Energy Boost'
    };
    
    const buttons = document.querySelectorAll('.technique-btn');
    buttons.forEach(btn => {
        if (btn.textContent.trim() === techniqueNames[techniqueKey]) {
            btn.classList.add('active');
        }
    });
}

function startBreathing() {
    if (isPaused) {
        isPaused = false;
        updateButtonStates();
        
        const circle = safeGetElement('breathingCircle');
        if (circle) {
            circle.classList.add('active');
        }
        
        animateBreathingProgress();
        
        const remainingTime = (techniques[currentTechnique].phases[currentPhase].duration - currentPhaseProgress) * 1000;
        breathingInterval = setTimeout(() => {
            nextPhase();
        }, remainingTime);
        
        startTimers();
        return;
    }

    isBreathing = true;
    isPaused = false;
    currentPhase = 0;
    phaseTimer = 0;
    totalTimer = 0;
    breathCount = 0;
    totalBreathTime = 0;
    breathStartTime = Date.now();
    currentPhaseProgress = 0;
    
    sessionDuration = getSessionDuration();
    sessionStartTime = Date.now();
    sessionTimer = 0;
    
    const sessionInfo = safeGetElement('sessionInfo');
    if (sessionInfo && sessionDuration !== -1) {
        sessionInfo.style.display = 'block';
    }

    updateButtonStates();
    
    const sessionStats = safeGetElement('sessionStats');
    if (sessionStats) {
        sessionStats.style.display = 'flex';
    }

    const circle = safeGetElement('breathingCircle');
        if (circle) {
            circle.classList.add('active');
    
    // ADDED: Ensure proper technique class is applied
            const technique = techniques[currentTechnique];
            circle.classList.remove('technique-478', 'technique-box', 'technique-coherent', 'technique-triangle', 'technique-wim');
            circle.classList.add(technique.circleClass);
    
    // Force animation restart
            circle.style.animation = 'none';
            requestAnimationFrame(() => {
           circle.style.animation = '';
    });
}

    vibrate(100);

    startBreathingCycle();
    startTimers();
    
    if (typeof gtag !== 'undefined') {
        gtag('event', 'session_start', {
            'event_category': 'breathing',
            'event_label': currentTechnique,
            'value': sessionDuration === -1 ? 0 : Math.floor(sessionDuration / 60)
        });
    }
}

function pauseBreathing() {
    isPaused = true;
    clearTimeout(breathingInterval);
    clearInterval(timerInterval);
    clearInterval(sessionInterval);
    cancelAnimationFrame(animationInterval);
    
    updateButtonStates();
    
    const breathingText = safeGetElement('breathingText');
    if (breathingText) {
        breathingText.textContent = 'Paused - click Begin to continue';
    }
    
    const circle = safeGetElement('breathingCircle');
    if (circle) {
        circle.classList.remove('active');
    }
}

function stopBreathing() {
    isBreathing = false;
    isPaused = false;
    clearTimeout(breathingInterval);
    clearInterval(timerInterval);
    clearInterval(sessionInterval);
    cancelAnimationFrame(animationInterval);

    updateButtonStates();

    const technique = techniques[currentTechnique];
    const circle = safeGetElement('breathingCircle');
    
    if (circle) {
        circle.classList.remove('active');
    }
    
    setTimeout(() => {
        if (circle) {
            circle.className = `breathing-circle ${technique.circleClass}`;
        }
        
        const circleText = safeGetElement('circleText');
        if (circleText) {
            circleText.textContent = 'Ready';
        }
        
        const breathingText = safeGetElement('breathingText');
        if (breathingText) {
            breathingText.textContent = 'Click Begin to start your practice';
        }
        
        const progressFill = safeGetElement('progressFill');
        if (progressFill) {
            progressFill.style.width = '0%';
        }
        
        const progressTime = safeGetElement('progressTime');
        if (progressTime) {
            progressTime.textContent = '';
        }
        
        const timer = safeGetElement('timer');
        if (timer) {
            timer.textContent = '00:00';
        }
        
        const sessionInfo = safeGetElement('sessionInfo');
        if (sessionInfo) {
            sessionInfo.style.display = 'none';
        }
        
        setTimeout(() => {
            const sessionStats = safeGetElement('sessionStats');
            if (sessionStats) {
                sessionStats.style.display = 'none';
            }
        }, 3000);
    }, 300);
    
    vibrate([100, 50, 100]);
    
    currentPhase = 0;
    phaseTimer = 0;
    totalTimer = 0;
    sessionTimer = 0;
    currentPhaseProgress = 0;
}

function updateButtonStates() {
    const startBtn = safeGetElement('startBtn');
    const pauseBtn = safeGetElement('pauseBtn');
    const stopBtn = safeGetElement('stopBtn');
    
    if (startBtn) startBtn.disabled = isBreathing && !isPaused;
    if (pauseBtn) pauseBtn.disabled = !isBreathing || isPaused;
    if (stopBtn) stopBtn.disabled = !isBreathing;
}

function startBreathingCycle() {
    const technique = techniques[currentTechnique];
    const phase = technique.phases[currentPhase];
    
    const circleText = safeGetElement('circleText');
    if (circleText) {
        circleText.textContent = phase.name;
    }
    
    const breathingText = safeGetElement('breathingText');
    if (breathingText) {
        breathingText.textContent = phase.text;
    }
    
    if (currentPhase === 0) {
        breathCount++;
        if (breathStartTime > 0) {
            totalBreathTime += (Date.now() - breathStartTime) / 1000;
            breathStartTime = Date.now();
        }
        updateStats();
    }
    
    if (phase.frequency > 0) {
        playBreathingSound(phase.frequency, phase.duration);
    }
    
    if (phase.name === 'Inhale') {
        vibrate([50, 100, 50]);
    } else if (phase.name === 'Exhale') {
        vibrate([100, 50, 100]);
    }
    
    phaseTimer = phase.duration;
    phaseStartTime = performance.now();
    currentPhaseProgress = 0;
    
    animateBreathingProgress();
    
    breathingInterval = setTimeout(() => {
        nextPhase();
    }, phase.duration * 1000);
}

function nextPhase() {
    const technique = techniques[currentTechnique];
    currentPhase = (currentPhase + 1) % technique.phases.length;
    
    if (isBreathing && !isPaused) {
        startBreathingCycle();
    }
}

function animateBreathingProgress() {
    if (!isBreathing || isPaused) return;
    
    const technique = techniques[currentTechnique];
    const phase = technique.phases[currentPhase];
    const currentTime = performance.now();
    const elapsed = (currentTime - phaseStartTime) / 1000;
    
    currentPhaseProgress = Math.min(elapsed / phase.duration, 1);
    const progressPercent = currentPhaseProgress * 100;
    
    const progressFill = safeGetElement('progressFill');
    if (progressFill) {
        progressFill.style.width = `${progressPercent}%`;
    }
    
    if (Math.floor(elapsed * 4) !== Math.floor((elapsed - 0.016) * 4)) {
        const remainingTime = Math.max(phase.duration - elapsed, 0);
        const progressTime = safeGetElement('progressTime');
        if (progressTime) {
            progressTime.textContent = `${Math.ceil(remainingTime)}s`;
        }
    }
    
    if (currentPhaseProgress < 1 && isBreathing && !isPaused) {
        animationInterval = requestAnimationFrame(animateBreathingProgress);
    }
}

function startTimers() {
    timerInterval = setInterval(() => {
        totalTimer++;
        const minutes = Math.floor(totalTimer / 60);
        const seconds = totalTimer % 60;
        const timer = safeGetElement('timer');
        if (timer) {
            timer.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }, 1000);
    
    if (sessionDuration !== -1) {
        sessionInterval = setInterval(() => {
            updateSessionProgress();
        }, 1000);
    }
}

function updateStats() {
    const breathCountEl = safeGetElement('breathCount');
    if (breathCountEl) {
        breathCountEl.textContent = breathCount;
    }
    
    if (breathCount > 0) {
        const avgTime = Math.round(totalBreathTime / breathCount);
        const avgBreathTime = safeGetElement('avgBreathTime');
        if (avgBreathTime) {
            avgBreathTime.textContent = `${avgTime}s`;
        }
    }
    
    const sessionProgress = safeGetElement('sessionProgress');
    if (sessionProgress) {
        if (sessionDuration !== -1) {
            const elapsed = (Date.now() - sessionStartTime) / 1000;
            const progress = Math.min((elapsed / sessionDuration) * 100, 100);
            sessionProgress.textContent = `${Math.round(progress)}%`;
        } else {
            sessionProgress.textContent = '∞';
        }
    }
}

document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    
    switch(e.code) {
        case 'Space':
            e.preventDefault();
            if (isBreathing && !isPaused) {
                pauseBreathing();
            } else {
                startBreathing();
            }
            break;
        case 'KeyS':
            if (isBreathing) {
                e.preventDefault();
                stopBreathing();
            }
            break;
        case 'Digit1':
            e.preventDefault();
            selectTechnique('478');
            break;
        case 'Digit2':
            e.preventDefault();
            selectTechnique('box');
            break;
        case 'Digit3':
            e.preventDefault();
            selectTechnique('coherent');
            break;
        case 'Digit4':
            e.preventDefault();
            selectTechnique('triangle');
            break;
        case 'Digit5':
            e.preventDefault();
            selectTechnique('wim');
            break;
    }
});

document.addEventListener('DOMContentLoaded', function() {
    console.log('Initializing Help Me Breathe...');
    
    try {
        initializeSettings();
        selectTechnique('478');
        sessionDuration = getSessionDuration();
        
        setTimeout(() => {
            const hint = safeGetElement('keyboardHint');
            if (hint) {
                hint.classList.add('show');
                setTimeout(() => hint.classList.remove('show'), 5000);
            }
        }, 3000);
        
        if (!navigator.vibrate) {
            const vibrationToggle = safeGetElement('vibrationToggle');
            if (vibrationToggle && vibrationToggle.parentElement) {
                vibrationToggle.parentElement.style.display = 'none';
            }
        }
        
        document.addEventListener('click', () => {
            if (!audioSystem.isInitialized && soundEnabled) {
                audioSystem.init();
            }
        }, { once: true });
        
        console.log('Initialization complete');
        
    } catch (error) {
        console.error('Initialization failed:', error);
    }
});

let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        if (isBreathing && !isPaused) {
            const circle = safeGetElement('breathingCircle');
            if (circle) {
                circle.style.animationPlayState = 'paused';
                requestAnimationFrame(() => {
                    circle.style.animationPlayState = 'running';
                });
            }
        }
    }, 250);
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && isBreathing && !isPaused) {
        // pauseBreathing();
    }
});

window.addEventListener('beforeunload', () => {
    if (audioSystem) {
        audioSystem.stop();
    }
    
    clearTimeout(breathingInterval);
    clearInterval(timerInterval);
    clearInterval(sessionInterval);
    cancelAnimationFrame(animationInterval);
    
    if (isBreathing && typeof gtag !== 'undefined') {
        gtag('event', 'session_abandon', {
            'event_category': 'breathing',
            'event_label': currentTechnique,
            'value': totalTimer
        });
    }
});

if ('ontouchstart' in window) {
    const techniqueButtons = document.querySelector('.technique-buttons');
    if (techniqueButtons) {
        techniqueButtons.addEventListener('touchstart', function(e) {
            this.style.scrollBehavior = 'smooth';
        }, { passive: true });
    }
}

window.selectTechnique = selectTechnique;
window.startBreathing = startBreathing;
window.pauseBreathing = pauseBreathing;
window.stopBreathing = stopBreathing;
