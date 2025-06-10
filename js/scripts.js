let currentTechnique = '478';
let isBreathing = false;
let isPaused = false;
let currentPhase = 0;
let phaseTimer = 0;
let totalTimer = 0;
let breathingInterval;
let timerInterval;
let progressInterval;
let breathCount = 0;
let breathStartTime = 0;
let totalBreathTime = 0;

// Settings
let soundEnabled = true;
let vibrationEnabled = true;

// Audio context for sound generation
let audioContext;

// Enhanced Audio System for Natural Breathing Sounds
class BreathingAudioSystem {
    constructor() {
        this.audioContext = null;
        this.isInitialized = false;
        this.activeNodes = [];
    }

    init() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.isInitialized = true;
        }
    }

    // Create a more complex, natural sound
    createNaturalTone(frequency, duration, type = 'inhale') {
        this.init();
        
        const now = this.audioContext.currentTime;
        const endTime = now + duration;
        
        // Main oscillator with warmer triangle wave
        const mainOsc = this.audioContext.createOscillator();
        mainOsc.type = 'triangle'; // Warmer than sine
        mainOsc.frequency.setValueAtTime(frequency, now);
        
        // Add subtle frequency modulation for natural feel
        const vibrato = this.audioContext.createOscillator();
        vibrato.frequency.setValueAtTime(4.5, now); // Slow vibrato
        const vibratoGain = this.audioContext.createGain();
        vibratoGain.gain.setValueAtTime(frequency * 0.01, now); // 1% frequency variation
        vibrato.connect(vibratoGain);
        vibratoGain.connect(mainOsc.frequency);
        
        // Second harmonic for richness
        const harmonic = this.audioContext.createOscillator();
        harmonic.type = 'sine';
        harmonic.frequency.setValueAtTime(frequency * 2, now);
        
        // Sub-harmonic for depth
        const subHarmonic = this.audioContext.createOscillator();
        subHarmonic.type = 'sine';
        subHarmonic.frequency.setValueAtTime(frequency * 0.5, now);
        
        // Gain nodes for mixing
        const mainGain = this.audioContext.createGain();
        const harmonicGain = this.audioContext.createGain();
        const subGain = this.audioContext.createGain();
        
        // Set relative volumes
        mainGain.gain.setValueAtTime(0, now);
        harmonicGain.gain.setValueAtTime(0, now);
        subGain.gain.setValueAtTime(0, now);
        
        // Low-pass filter for smoothness
        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(frequency * 3, now);
        filter.Q.setValueAtTime(0.5, now);
        
        // Master gain with envelope
        const masterGain = this.audioContext.createGain();
        masterGain.gain.setValueAtTime(0, now);
        
        // Connect the audio graph
        mainOsc.connect(mainGain);
        harmonic.connect(harmonicGain);
        subHarmonic.connect(subGain);
        
        mainGain.connect(filter);
        harmonicGain.connect(filter);
        subGain.connect(filter);
        
        filter.connect(masterGain);
        masterGain.connect(this.audioContext.destination);
        
        // Natural envelope based on breath type
        if (type === 'inhale') {
            // Gentle rise like drawing breath
            masterGain.gain.linearRampToValueAtTime(0.02, now + 0.3);
            masterGain.gain.exponentialRampToValueAtTime(0.035, now + duration * 0.7);
            masterGain.gain.exponentialRampToValueAtTime(0.02, now + duration - 0.1);
            masterGain.gain.linearRampToValueAtTime(0, endTime);
            
            // Gradually introduce harmonics
            mainGain.gain.linearRampToValueAtTime(0.7, now + 0.5);
            harmonicGain.gain.linearRampToValueAtTime(0.15, now + 1);
            subGain.gain.linearRampToValueAtTime(0.2, now + 0.3);
            
            // Filter sweep for natural breath sound
            filter.frequency.exponentialRampToValueAtTime(frequency * 4, now + duration * 0.5);
            filter.frequency.exponentialRampToValueAtTime(frequency * 2, endTime);
        } else if (type === 'exhale') {
            // Gentle release like letting go
            masterGain.gain.linearRampToValueAtTime(0.025, now + 0.1);
            masterGain.gain.exponentialRampToValueAtTime(0.015, now + duration * 0.5);
            masterGain.gain.exponentialRampToValueAtTime(0.005, now + duration - 0.3);
            masterGain.gain.linearRampToValueAtTime(0, endTime);
            
            // Different harmonic balance for exhale
            mainGain.gain.linearRampToValueAtTime(0.8, now + 0.2);
            harmonicGain.gain.linearRampToValueAtTime(0.1, now + 0.5);
            subGain.gain.linearRampToValueAtTime(0.3, now + 0.2);
            
            // Descending filter for release
            filter.frequency.exponentialRampToValueAtTime(frequency * 1.5, now + duration * 0.7);
            filter.frequency.exponentialRampToValueAtTime(frequency * 0.8, endTime);
        }
        
        // Start oscillators
        vibrato.start(now);
        mainOsc.start(now);
        harmonic.start(now);
        subHarmonic.start(now);
        
        // Stop oscillators
        vibrato.stop(endTime + 0.1);
        mainOsc.stop(endTime + 0.1);
        harmonic.stop(endTime + 0.1);
        subHarmonic.stop(endTime + 0.1);
        
        // Track active nodes for cleanup
        this.activeNodes.push({ vibrato, mainOsc, harmonic, subHarmonic, endTime });
    }

    // Create ambient pad sound for hold phases
    createAmbientPad(duration) {
        this.init();
        
        const now = this.audioContext.currentTime;
        const endTime = now + duration;
        
        // Create pink noise for texture
        const bufferSize = 2 * this.audioContext.sampleRate;
        const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < bufferSize; i++) {
            const white = Math.random() * 2 - 1;
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.0168980;
            output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.03;
            b6 = white * 0.115926;
        }
        
        const noiseSource = this.audioContext.createBufferSource();
        noiseSource.buffer = noiseBuffer;
        noiseSource.loop = true;
        
        // Filter for shaping
        const filter1 = this.audioContext.createBiquadFilter();
        filter1.type = 'bandpass';
        filter1.frequency.setValueAtTime(400, now);
        filter1.Q.setValueAtTime(0.3, now);
        
        const filter2 = this.audioContext.createBiquadFilter();
        filter2.type = 'lowpass';
        filter2.frequency.setValueAtTime(800, now);
        
        // Gain with envelope
        const gainNode = this.audioContext.createGain();
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.01, now + 1);
        gainNode.gain.setValueAtTime(0.01, endTime - 1);
        gainNode.gain.linearRampToValueAtTime(0, endTime);
        
        // Connect
        noiseSource.connect(filter1);
        filter1.connect(filter2);
        filter2.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        noiseSource.start(now);
        noiseSource.stop(endTime);
    }

    cleanup() {
        const now = this.audioContext ? this.audioContext.currentTime : 0;
        this.activeNodes = this.activeNodes.filter(node => node.endTime > now);
    }
}

// Create the audio system instance
const audioSystem = new BreathingAudioSystem();

const techniques = {
    '478': {
        name: '🌙 Deep Sleep',
        title: 'Deep Sleep & Relaxation',
        theme: 'theme-478',
        circleClass: 'technique-478',
        phases: [
            { name: 'Inhale', duration: 4, class: 'inhale', text: 'Breathe in slowly, filling with moonlight...', frequency: 174.61 }, // F3 - calming
            { name: 'Hold', duration: 7, class: 'hold', text: 'Hold gently, let the calm settle in...', frequency: 0 },
            { name: 'Exhale', duration: 8, class: 'exhale', text: 'Release completely, drift into peace...', frequency: 130.81 } // C3 - grounding
        ],
        description: 'The 4-7-8 breathing technique helps activate your parasympathetic nervous system, promoting deep relaxation and better sleep. Like the gentle phases of the moon, this practice guides you into peaceful rest.'
    },
    'box': {
        name: '🌿 Focus & Grounding',
        title: 'Earth Connection & Mental Clarity',
        theme: 'theme-box',
        circleClass: 'technique-box',
        phases: [
            { name: 'Inhale', duration: 4, class: 'inhale', text: 'Draw in earth\'s grounding energy...', frequency: 146.83 }, // D3 - rooting
            { name: 'Hold', duration: 4, class: 'hold', text: 'Feel rooted and centered...', frequency: 0 },
            { name: 'Exhale', duration: 4, class: 'exhale', text: 'Release with steady control...', frequency: 110 }, // A2 - deep grounding
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
            { name: 'Inhale', duration: 5, class: 'inhale', text: 'Breathe love into your heart...', frequency: 220 }, // A3 - heart opening
            { name: 'Exhale', duration: 5, class: 'exhale', text: 'Send gratitude flowing outward...', frequency: 164.81 } // E3 - release
        ],
        description: 'Heart coherence breathing creates a harmonious flow between mind and heart. Like gentle waves, this rhythm reduces stress and opens you to deeper emotional balance.'
    },
    'triangle': {
        name: '☁️ Quick Calm',
        title: 'Sky Breath & Instant Peace',
        theme: 'theme-triangle',
        circleClass: 'technique-triangle',
        phases: [
            { name: 'Inhale', duration: 3, class: 'inhale', text: 'Breathe in fresh clarity...', frequency: 261.63 }, // C4 - clarity
            { name: 'Hold', duration: 3, class: 'hold', text: 'Float in peaceful pause...', frequency: 0 },
            { name: 'Exhale', duration: 3, class: 'exhale', text: 'Let go like a soft breeze...', frequency: 196 } // G3 - release
        ],
        description: 'Quick and balancing, this technique brings the lightness of clouds and sky. Perfect for busy moments when you need instant calm and mental clarity.'
    },
    'wim': {
        name: '☀️ Energy Boost',
        title: 'Solar Power & Vitality',
        theme: 'theme-wim',
        circleClass: 'technique-wim',
        phases: [
            { name: 'Inhale', duration: 2, class: 'inhale', text: 'Draw in solar energy...', frequency: 329.63 }, // E4 - energizing
            { name: 'Exhale', duration: 1, class: 'exhale', text: 'Release with power...', frequency: 246.94 } // B3 - grounding energy
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
    // Force CSS to recalculate for natural elements
    const elements = document.querySelectorAll('.natural-element');
    elements.forEach(el => {
        el.style.display = 'none';
        void el.offsetWidth; // Force reflow
        el.style.display = '';
    });
    
    // Also update the nature background
    const natureBg = document.querySelector('.nature-bg');
    if (natureBg) {
        natureBg.style.opacity = '0';
        setTimeout(() => {
            natureBg.style.opacity = '';
        }, 50);
    }
}

// Update the breathing sound function
function playBreathingSound(frequency, duration) {
    if (!soundEnabled || frequency === 0) {
        // For hold phases, play ambient pad
        if (soundEnabled && frequency === 0) {
            audioSystem.createAmbientPad(duration);
        }
        return;
    }
    
    try {
        const technique = techniques[currentTechnique];
        const phase = technique.phases[currentPhase];
        
        // Use the enhanced audio system
        audioSystem.createNaturalTone(frequency, duration, phase.name.toLowerCase());
        
        // Cleanup old nodes periodically
        audioSystem.cleanup();
        
    } catch (e) {
        console.log('Enhanced audio not supported:', e);
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
    
    // Change theme - force a reflow to ensure CSS transitions work
    document.body.className = '';
    void document.body.offsetWidth; // Force reflow
    document.body.className = technique.theme;
    
    // Update UI
    document.getElementById('technique-title').textContent = technique.name;
    document.getElementById('techniqueInfo').innerHTML = `
        <h3>${technique.title}</h3>
        <p>${technique.description}</p>
    `;
    
    // Update breathing circle - remove all classes and re-add
    const circle = document.getElementById('breathingCircle');
    circle.className = '';
    void circle.offsetWidth; // Force reflow
    circle.className = `breathing-circle ${technique.circleClass}`;
    circle.style.transitionDuration = '2.5s'; // Reset transition duration
    
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
    
    // Force update of natural elements visibility
    updateNaturalElements();
}

function startBreathing() {
    if (isPaused) {
        isPaused = false;
        document.getElementById('startBtn').disabled = true;
        document.getElementById('pauseBtn').disabled = false;
        document.getElementById('stopBtn').disabled = false;
        
        const circle = document.getElementById('breathingCircle');
        circle.classList.add('active');
        
        startBreathingCycle();
        startTimers();
        return;
    }

    isBreathing = true;
    currentPhase = 0;
    phaseTimer = 0;
    totalTimer = 0;
    breathCount = 0;
    totalBreathTime = 0;
    breathStartTime = Date.now();

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
    clearInterval(breathingInterval);
    clearInterval(timerInterval);
    clearInterval(progressInterval);
    
    document.getElementById('startBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('breathingText').textContent = 'Paused - click Begin to continue';
    
    const circle = document.getElementById('breathingCircle');
    circle.classList.remove('active');
}

function stopBreathing() {
    isBreathing = false;
    isPaused = false;
    clearInterval(breathingInterval);
    clearInterval(timerInterval);
    clearInterval(progressInterval);

    document.getElementById('startBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;

    const technique = techniques[currentTechnique];
    const circle = document.getElementById('breathingCircle');
    
    // Remove all classes and reset
    circle.className = '';
    circle.style.transform = '';
    circle.style.transitionDuration = '';
    void circle.offsetWidth; // Force reflow
    
    // Re-add the appropriate classes
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
    
    // Completion vibration pattern
    vibrate([100, 50, 100]);
    
    currentPhase = 0;
    phaseTimer = 0;
    totalTimer = 0;
}

function startBreathingCycle() {
    const technique = techniques[currentTechnique];
    const phase = technique.phases[currentPhase];
    
    const circle = document.getElementById('breathingCircle');
    
    // Reset transition for immediate state change
    circle.style.transition = 'none';
    circle.className = `breathing-circle ${technique.circleClass} active`;
    void circle.offsetWidth; // Force reflow
    
    // Now apply the transition and phase
    circle.style.transition = '';
    circle.style.transitionDuration = `${phase.duration}s`;
    circle.className = `breathing-circle ${technique.circleClass} ${phase.class} active`;
    
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
    
    // Update progress bar smoothly
    let elapsed = 0;
    const updateFrequency = 100; // Update every 100ms for smooth animation
    
    clearInterval(progressInterval);
    progressInterval = setInterval(() => {
        elapsed += updateFrequency / 1000;
        const progress = Math.min((elapsed / phase.duration) * 100, 100);
        document.getElementById('progressFill').style.width = `${progress}%`;
        
        const remainingTime = Math.max(phase.duration - elapsed, 0);
        document.getElementById('progressTime').textContent = `${Math.ceil(remainingTime)}s`;
        
        if (elapsed >= phase.duration) {
            clearInterval(progressInterval);
        }
    }, updateFrequency);
    
    breathingInterval = setInterval(() => {
        phaseTimer--;
        
        if (phaseTimer <= 0) {
            clearInterval(breathingInterval);
            
            currentPhase = (currentPhase + 1) % technique.phases.length;
            
            if (isBreathing && !isPaused) {
                setTimeout(() => {
                    startBreathingCycle();
                }, 200);
            }
        }
    }, 1000);
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
