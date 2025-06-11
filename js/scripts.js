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

// Animation timing
let phaseStartTime = 0;
let currentPhaseProgress = 0;

// Settings
let soundEnabled = true;
let vibrationEnabled = true;

// Audio context for sound generation
let audioContext;

// Enhanced Audio System with Binaural Beats and Nature Sounds
class EnhancedBreathingAudio {
    constructor() {
        this.audioContext = null;
        this.isInitialized = false;
        this.activeNodes = new Set();
        this.masterGain = null;
        this.binauralEnabled = true;
    }

    init() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.setValueAtTime(0.3, this.audioContext.currentTime);
            this.masterGain.connect(this.audioContext.destination);
            this.isInitialized = true;
        }
    }

    // Create binaural beat effect
    createBinauralBeat(baseFreq, beatFreq, duration) {
        const leftOsc = this.audioContext.createOscillator();
        const rightOsc = this.audioContext.createOscillator();
        const leftGain = this.audioContext.createGain();
        const rightGain = this.audioContext.createGain();
        const merger = this.audioContext.createChannelMerger(2);
        
        leftOsc.frequency.setValueAtTime(baseFreq, this.audioContext.currentTime);
        rightOsc.frequency.setValueAtTime(baseFreq + beatFreq, this.audioContext.currentTime);
        
        leftOsc.connect(leftGain);
        rightOsc.connect(rightGain);
        leftGain.connect(merger, 0, 0);
        rightGain.connect(merger, 0, 1);
        
        return { leftOsc, rightOsc, merger, leftGain, rightGain };
    }

    // Create layered, natural breathing sound
    createBreathSound(frequency, duration, type = 'inhale') {
        this.init();
        
        const now = this.audioContext.currentTime;
        const endTime = now + duration;
        
        // Base tone with warm triangle wave
        const baseOsc = this.audioContext.createOscillator();
        baseOsc.type = 'triangle';
        baseOsc.frequency.setValueAtTime(frequency, now);
        
        // Add subtle vibrato for naturalness
        const vibrato = this.audioContext.createOscillator();
        vibrato.frequency.setValueAtTime(5.5, now);
        const vibratoGain = this.audioContext.createGain();
        vibratoGain.gain.setValueAtTime(frequency * 0.015, now);
        vibrato.connect(vibratoGain);
        vibratoGain.connect(baseOsc.frequency);
        
        // Harmonic layers
        const harmonic1 = this.audioContext.createOscillator();
        harmonic1.type = 'sine';
        harmonic1.frequency.setValueAtTime(frequency * 2, now);
        
        const harmonic2 = this.audioContext.createOscillator();
        harmonic2.type = 'sine';
        harmonic2.frequency.setValueAtTime(frequency * 3, now);
        
        const subHarmonic = this.audioContext.createOscillator();
        subHarmonic.type = 'sine';
        subHarmonic.frequency.setValueAtTime(frequency * 0.5, now);
        
        // Create pink noise for breath texture
        const noiseBuffer = this.audioContext.createBuffer(1, duration * this.audioContext.sampleRate, this.audioContext.sampleRate);
        const noiseData = noiseBuffer.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < noiseData.length; i++) {
            const white = Math.random() * 2 - 1;
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.0168980;
            noiseData[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.02;
            b6 = white * 0.115926;
        }
        
        const noiseSource = this.audioContext.createBufferSource();
        noiseSource.buffer = noiseBuffer;
        
        // Gain envelopes
        const baseGain = this.audioContext.createGain();
        const harmonicGain1 = this.audioContext.createGain();
        const harmonicGain2 = this.audioContext.createGain();
        const subGain = this.audioContext.createGain();
        const noiseGain = this.audioContext.createGain();
        
        // Filters for shaping
        const baseFilter = this.audioContext.createBiquadFilter();
        baseFilter.type = 'lowpass';
        baseFilter.frequency.setValueAtTime(frequency * 4, now);
        baseFilter.Q.setValueAtTime(0.7, now);
        
        const noiseFilter = this.audioContext.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.frequency.setValueAtTime(1000, now);
        noiseFilter.Q.setValueAtTime(0.5, now);
        
        // Connect audio graph
        baseOsc.connect(baseGain);
        harmonic1.connect(harmonicGain1);
        harmonic2.connect(harmonicGain2);
        subHarmonic.connect(subGain);
        noiseSource.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        
        baseGain.connect(baseFilter);
        harmonicGain1.connect(baseFilter);
        harmonicGain2.connect(baseFilter);
        subGain.connect(baseFilter);
        noiseGain.connect(this.masterGain);
        baseFilter.connect(this.masterGain);
        
        // Natural envelopes for different breath phases
        if (type === 'inhale') {
            // Gradual rise
            baseGain.gain.setValueAtTime(0, now);
            baseGain.gain.linearRampToValueAtTime(0.3, now + 0.5);
            baseGain.gain.exponentialRampToValueAtTime(0.5, now + duration * 0.7);
            baseGain.gain.exponentialRampToValueAtTime(0.3, now + duration - 0.2);
            baseGain.gain.linearRampToValueAtTime(0, endTime);
            
            harmonicGain1.gain.setValueAtTime(0, now);
            harmonicGain1.gain.linearRampToValueAtTime(0.1, now + 1);
            harmonicGain1.gain.linearRampToValueAtTime(0, endTime);
            
            harmonicGain2.gain.setValueAtTime(0, now);
            harmonicGain2.gain.linearRampToValueAtTime(0.05, now + 1.5);
            harmonicGain2.gain.linearRampToValueAtTime(0, endTime);
            
            subGain.gain.setValueAtTime(0, now);
            subGain.gain.linearRampToValueAtTime(0.15, now + 0.3);
            subGain.gain.linearRampToValueAtTime(0, endTime);
            
            noiseGain.gain.setValueAtTime(0, now);
            noiseGain.gain.linearRampToValueAtTime(0.08, now + 0.2);
            noiseGain.gain.exponentialRampToValueAtTime(0.12, now + duration * 0.5);
            noiseGain.gain.linearRampToValueAtTime(0, endTime);
            
            // Filter sweep
            baseFilter.frequency.exponentialRampToValueAtTime(frequency * 6, now + duration * 0.5);
            baseFilter.frequency.exponentialRampToValueAtTime(frequency * 3, endTime);
            
        } else if (type === 'exhale') {
            // Gentle release
            baseGain.gain.setValueAtTime(0, now);
            baseGain.gain.linearRampToValueAtTime(0.4, now + 0.2);
            baseGain.gain.exponentialRampToValueAtTime(0.2, now + duration * 0.5);
            baseGain.gain.exponentialRampToValueAtTime(0.05, now + duration - 0.5);
            baseGain.gain.linearRampToValueAtTime(0, endTime);
            
            harmonicGain1.gain.setValueAtTime(0, now);
            harmonicGain1.gain.linearRampToValueAtTime(0.08, now + 0.5);
            harmonicGain1.gain.linearRampToValueAtTime(0, endTime);
            
            harmonicGain2.gain.setValueAtTime(0, now);
            harmonicGain2.gain.linearRampToValueAtTime(0.03, now + 0.7);
            harmonicGain2.gain.linearRampToValueAtTime(0, endTime);
            
            subGain.gain.setValueAtTime(0, now);
            subGain.gain.linearRampToValueAtTime(0.2, now + 0.2);
            subGain.gain.exponentialRampToValueAtTime(0.1, now + duration * 0.7);
            subGain.gain.linearRampToValueAtTime(0, endTime);
            
            noiseGain.gain.setValueAtTime(0, now);
            noiseGain.gain.linearRampToValueAtTime(0.15, now + 0.1);
            noiseGain.gain.exponentialRampToValueAtTime(0.05, now + duration * 0.6);
            noiseGain.gain.linearRampToValueAtTime(0, endTime);
            
            // Descending filter
            baseFilter.frequency.exponentialRampToValueAtTime(frequency * 2, now + duration * 0.7);
            baseFilter.frequency.exponentialRampToValueAtTime(frequency, endTime);
        }
        
        // Start oscillators
        vibrato.start(now);
        baseOsc.start(now);
        harmonic1.start(now);
        harmonic2.start(now);
        subHarmonic.start(now);
        noiseSource.start(now);
        
        // Stop oscillators
        vibrato.stop(endTime + 0.1);
        baseOsc.stop(endTime + 0.1);
        harmonic1.stop(endTime + 0.1);
        harmonic2.stop(endTime + 0.1);
        subHarmonic.stop(endTime + 0.1);
        noiseSource.stop(endTime + 0.1);
        
        // Add binaural beat for deep relaxation techniques
        if (this.binauralEnabled && (currentTechnique === '478' || currentTechnique === 'coherent')) {
            const beatFreq = currentTechnique === '478' ? 4 : 8; // Delta for sleep, Alpha for coherence
            const binaural = this.createBinauralBeat(frequency, beatFreq, duration);
            
            const binauralGain = this.audioContext.createGain();
            binauralGain.gain.setValueAtTime(0, now);
            binauralGain.gain.linearRampToValueAtTime(0.1, now + 1);
            binauralGain.gain.linearRampToValueAtTime(0, endTime);
            
            binaural.merger.connect(binauralGain);
            binauralGain.connect(this.masterGain);
            
            binaural.leftOsc.start(now);
            binaural.rightOsc.start(now);
            binaural.leftOsc.stop(endTime);
            binaural.rightOsc.stop(endTime);
        }
        
        // Track active nodes
        this.activeNodes.add({ endTime, nodes: [vibrato, baseOsc, harmonic1, harmonic2, subHarmonic, noiseSource] });
    }

    // Create ambient hold sound
    createHoldSound(duration) {
        this.init();
        
        const now = this.audioContext.currentTime;
        const endTime = now + duration;
        
        // Soft pad sound
        const osc1 = this.audioContext.createOscillator();
        const osc2 = this.audioContext.createOscillator();
        osc1.type = 'sine';
        osc2.type = 'sine';
        
        // Slightly detuned for richness
        const baseFreq = 110; // A2
        osc1.frequency.setValueAtTime(baseFreq, now);
        osc2.frequency.setValueAtTime(baseFreq * 1.01, now);
        
        // Slow LFO for gentle movement
        const lfo = this.audioContext.createOscillator();
        lfo.frequency.setValueAtTime(0.2, now);
        const lfoGain = this.audioContext.createGain();
        lfoGain.gain.setValueAtTime(5, now);
        lfo.connect(lfoGain);
        lfoGain.connect(osc1.frequency);
        lfoGain.connect(osc2.frequency);
        
        const gain1 = this.audioContext.createGain();
        const gain2 = this.audioContext.createGain();
        
        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(500, now);
        filter.Q.setValueAtTime(2, now);
        
        osc1.connect(gain1);
        osc2.connect(gain2);
        gain1.connect(filter);
        gain2.connect(filter);
        filter.connect(this.masterGain);
        
        // Gentle fade in and out
        gain1.gain.setValueAtTime(0, now);
        gain2.gain.setValueAtTime(0, now);
        gain1.gain.linearRampToValueAtTime(0.1, now + 1);
        gain2.gain.linearRampToValueAtTime(0.1, now + 1);
        gain1.gain.setValueAtTime(0.1, endTime - 1);
        gain2.gain.setValueAtTime(0.1, endTime - 1);
        gain1.gain.linearRampToValueAtTime(0, endTime);
        gain2.gain.linearRampToValueAtTime(0, endTime);
        
        lfo.start(now);
        osc1.start(now);
        osc2.start(now);
        lfo.stop(endTime);
        osc1.stop(endTime);
        osc2.stop(endTime);
        
        this.activeNodes.add({ endTime, nodes: [lfo, osc1, osc2] });
    }

    cleanup() {
        const now = this.audioContext ? this.audioContext.currentTime : 0;
        for (const node of this.activeNodes) {
            if (node.endTime < now - 1) {
                this.activeNodes.delete(node);
            }
        }
    }
}

// Create audio system instance
const audioSystem = new EnhancedBreathingAudio();

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

// Initialize audio context
function initAudio() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
}

// Update natural elements visibility
function updateNaturalElements() {
    requestAnimationFrame(() => {
        const elements = document.querySelectorAll('.natural-element');
        elements.forEach(el => {
            el.style.opacity = '0';
            setTimeout(() => {
                el.style.opacity = '';
            }, 100);
        });
        
        const natureBg = document.querySelector('.nature-bg');
        if (natureBg) {
            natureBg.style.opacity = '0';
            setTimeout(() => {
                natureBg.style.opacity = '';
            }, 150);
        }
    });
}

// Enhanced breathing sound function
function playBreathingSound(frequency, duration) {
    if (!soundEnabled) return;
    
    try {
        const technique = techniques[currentTechnique];
        const phase = technique.phases[currentPhase];
        
        if (frequency === 0) {
            // Hold phase
            audioSystem.createHoldSound(duration);
        } else {
            // Inhale or exhale
            audioSystem.createBreathSound(frequency, duration, phase.name.toLowerCase());
        }
        
        // Cleanup old nodes
        audioSystem.cleanup();
        
    } catch (e) {
        console.log('Audio error:', e);
    }
}

// Vibrate device
function vibrate(pattern) {
    if (!vibrationEnabled || !navigator.vibrate) return;
    navigator.vibrate(pattern);
}

// Settings panel
document.getElementById('settingsBtn').addEventListener('click', function(e) {
    e.stopPropagation();
    const panel = document.getElementById('settingsPanel');
    panel.classList.toggle('show');
});

// Close settings when clicking outside
document.addEventListener('click', function(e) {
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    
    if (!settingsBtn.contains(e.target) && !settingsPanel.contains(e.target)) {
        settingsPanel.classList.remove('show');
    }
});

// Toggle switches
document.getElementById('soundToggle').addEventListener('click', function() {
    soundEnabled = !soundEnabled;
    this.classList.toggle('active');
});

document.getElementById('vibrationToggle').addEventListener('click', function() {
    vibrationEnabled = !vibrationEnabled;
    this.classList.toggle('active');
});

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
    // Space bar to start/pause
    if (e.code === 'Space') {
        e.preventDefault();
        if (isBreathing && !isPaused) {
            pauseBreathing();
        } else {
            startBreathing();
        }
    }
    
    // S to stop
    if (e.key === 's' || e.key === 'S') {
        if (isBreathing) {
            stopBreathing();
        }
    }
    
    // Number keys 1-5 for techniques
    if (e.key >= '1' && e.key <= '5') {
        const techniqueKeys = ['478', 'box', 'coherent', 'triangle', 'wim'];
        const index = parseInt(e.key) - 1;
        if (index < techniqueKeys.length) {
            selectTechnique(techniqueKeys[index]);
        }
    }
});

// Show keyboard hint on focus
let hintTimeout;
document.addEventListener('DOMContentLoaded', function() {
    // Initialize the default technique
    selectTechnique('478');
    
    // Add SVG filter to the page
    const svgFilter = document.createElement('div');
    svgFilter.innerHTML = `
        <svg class="breathing-svg-filter" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <filter id="fluid-effect">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="blur" />
                    <feColorMatrix in="blur" mode="matrix" 
                        values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8" result="goo" />
                    <feComposite in="SourceGraphic" in2="goo" operator="atop"/>
                </filter>
            </defs>
        </svg>
    `;
    document.querySelector('.breathing-container').appendChild(svgFilter.firstElementChild);
    
    hintTimeout = setTimeout(() => {
        document.getElementById('keyboardHint').classList.add('show');
        setTimeout(() => {
            document.getElementById('keyboardHint').classList.remove('show');
        }, 5000);
    }, 3000);
    
    // Check for vibration support
    if (!navigator.vibrate) {
        const vibrationToggle = document.getElementById('vibrationToggle');
        if (vibrationToggle && vibrationToggle.parentElement) {
            vibrationToggle.parentElement.style.display = 'none';
        }
    }
});

function selectTechnique(techniqueKey) {
    if (isBreathing) {
        stopBreathing();
    }

    currentTechnique = techniqueKey;
    const technique = techniques[techniqueKey];
    
    // Smooth theme transition
    document.body.style.transition = 'all 1s cubic-bezier(0.4, 0, 0.2, 1)';
    document.body.className = technique.theme;
    
    // Update UI
    document.getElementById('technique-title').textContent = technique.name;
    document.getElementById('techniqueInfo').innerHTML = `
        <h3>${technique.title}</h3>
        <p>${technique.description}</p>
    `;
    
    // Update breathing circle
    const circle = document.getElementById('breathingCircle');
    circle.className = `breathing-circle ${technique.circleClass}`;
    
    // Reset progress bar
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressTime').textContent = '';
    
    // Update active button
    document.querySelectorAll('.technique-btn').forEach(btn => btn.classList.remove('active'));
    
    // Find and activate the correct button
    const buttons = document.querySelectorAll('.technique-btn');
    const techniqueNames = {
        '478': '🌙 Deep Sleep',
        'box': '🌿 Focus & Grounding',
        'coherent': '💗 Heart Coherence',
        'triangle': '☁️ Quick Calm',
        'wim': '☀️ Energy Boost'
    };
    
    buttons.forEach(btn => {
        if (btn.textContent.trim() === techniqueNames[techniqueKey]) {
            btn.classList.add('active');
        }
    });
    
    // Reset state
    document.getElementById('circleText').textContent = 'Ready';
    document.getElementById('breathingText').textContent = 'Click Begin to start your practice';
    
    // Update natural elements
    updateNaturalElements();
}

function startBreathing() {
    if (isPaused) {
        // Resume from pause
        isPaused = false;
        document.getElementById('startBtn').disabled = true;
        document.getElementById('pauseBtn').disabled = false;
        document.getElementById('stopBtn').disabled = false;
        
        const circle = document.getElementById('breathingCircle');
        circle.classList.add('active');
        
        // Resume animation
        animateBreathingProgress();
        
        // Resume phase timer
        const remainingTime = (techniques[currentTechnique].phases[currentPhase].duration - currentPhaseProgress) * 1000;
        breathingInterval = setTimeout(() => {
            nextPhase();
        }, remainingTime);
        
        startTimers();
        return;
    }

    // Start fresh
    isBreathing = true;
    isPaused = false;
    currentPhase = 0;
    phaseTimer = 0;
    totalTimer = 0;
    breathCount = 0;
    totalBreathTime = 0;
    breathStartTime = Date.now();
    currentPhaseProgress = 0;

    document.getElementById('startBtn').disabled = true;
    document.getElementById('pauseBtn').disabled = false;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('sessionStats').style.display = 'flex';

    const circle = document.getElementById('breathingCircle');
    circle.classList.add('active');

    // Small vibration to indicate start
    vibrate(100);

    startBreathingCycle();
    startTimers();
}

function pauseBreathing() {
    isPaused = true;
    clearTimeout(breathingInterval);
    clearInterval(timerInterval);
    cancelAnimationFrame(animationInterval);
    
    document.getElementById('startBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('breathingText').textContent = 'Paused - click Begin to continue';
    
    const circle = document.getElementById('breathingCircle');
    circle.classList.remove('active');
}

function stopBreathing() {
    isBreathing = false;
    isPaused = false;
    clearTimeout(breathingInterval);
    clearInterval(timerInterval);
    cancelAnimationFrame(animationInterval);

    document.getElementById('startBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;

    const technique = techniques[currentTechnique];
    const circle = document.getElementById('breathingCircle');
    
    // Smooth reset
    circle.classList.remove('active');
    
    setTimeout(() => {
        circle.className = `breathing-circle ${technique.circleClass}`;
        
        document.getElementById('circleText').textContent = 'Ready';
        document.getElementById('breathingText').textContent = 'Click Begin to start your practice';
        document.getElementById('progressFill').style.width = '0%';
        document.getElementById('progressTime').textContent = '';
        document.getElementById('timer').textContent = '00:00';
        
        // Hide session stats after a delay
        setTimeout(() => {
            document.getElementById('sessionStats').style.display = 'none';
        }, 3000);
    }, 300);
    
    // Completion vibration pattern
    vibrate([100, 50, 100]);
    
    currentPhase = 0;
    phaseTimer = 0;
    totalTimer = 0;
    currentPhaseProgress = 0;
}

function startBreathingCycle() {
    const technique = techniques[currentTechnique];
    const phase = technique.phases[currentPhase];
    
    const circle = document.getElementById('breathingCircle');
    
    document.getElementById('circleText').textContent = phase.name;
    document.getElementById('breathingText').textContent = phase.text;
    
    // Track breath cycles
    if (currentPhase === 0) {
        breathCount++;
        if (breathStartTime > 0) {
            totalBreathTime += (Date.now() - breathStartTime) / 1000;
            breathStartTime = Date.now();
        }
        updateStats();
    }
    
    // Play sound for this phase
    playBreathingSound(phase.frequency, phase.duration);
    
    // Vibration pattern based on phase
    if (phase.name === 'Inhale') {
        vibrate([50, 100, 50]);
    } else if (phase.name === 'Exhale') {
        vibrate([100, 50, 100]);
    }
    
    phaseTimer = phase.duration;
    phaseStartTime = performance.now();
    currentPhaseProgress = 0;
    
    // Start animation
    animateBreathingProgress();
    
    // Set timer for next phase
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

// Smooth progress animation using requestAnimationFrame
function animateBreathingProgress() {
    if (!isBreathing || isPaused) return;
    
    const technique = techniques[currentTechnique];
    const phase = technique.phases[currentPhase];
    const currentTime = performance.now();
    const elapsed = (currentTime - phaseStartTime) / 1000;
    
    currentPhaseProgress = Math.min(elapsed / phase.duration, 1);
    const progressPercent = currentPhaseProgress * 100;
    
    // Update progress bar smoothly
    const progressFill = document.getElementById('progressFill');
    progressFill.style.width = `${progressPercent}%`;
    
    // Update time display
    const remainingTime = Math.max(phase.duration - elapsed, 0);
    document.getElementById('progressTime').textContent = `${Math.ceil(remainingTime)}s`;
    
    // Continue animation
    if (currentPhaseProgress < 1 && isBreathing && !isPaused) {
        animationInterval = requestAnimationFrame(animateBreathingProgress);
    }
}

function startTimers() {
    timerInterval = setInterval(() => {
        totalTimer++;
        const minutes = Math.floor(totalTimer / 60);
        const seconds = totalTimer % 60;
        document.getElementById('timer').textContent = 
            `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
}

function updateStats() {
    document.getElementById('breathCount').textContent = breathCount;
    
    if (breathCount > 0) {
        const avgTime = Math.round(totalBreathTime / breathCount);
        document.getElementById('avgBreathTime').textContent = `${avgTime}s`;
    }
}

// Add smooth scrolling for technique buttons on mobile
if ('ontouchstart' in window) {
    const techniqueButtons = document.querySelector('.technique-buttons');
    if (techniqueButtons) {
        techniqueButtons.addEventListener('touchstart', function(e) {
            this.style.scrollBehavior = 'smooth';
        }, { passive: true });
    }
}

// Optimize resize handling
let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        if (isBreathing && !isPaused) {
            // Maintain smooth animation during resize
            const circle = document.getElementById('breathingCircle');
            circle.style.animationPlayState = 'paused';
            requestAnimationFrame(() => {
                circle.style.animationPlayState = 'running';
            });
        }
    }, 250);
});

// Add page visibility handling to pause audio when tab is hidden
document.addEventListener('visibilitychange', () => {
    if (document.hidden && isBreathing && !isPaused) {
        // Optionally pause when tab is hidden
        // pauseBreathing();
    }
});
