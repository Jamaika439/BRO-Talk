/**
 * AudioWorkletProcessor – Noise Gate
 * Kein ScriptProcessorNode mehr → kein Kratzen durch Main-Thread-Blocking
 */
class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._env      = 0;
    this._open     = false;
    this._floor    = 0.01;
    this._atk      = 0.97;   // Attack  (je näher an 1 = langsamer öffnen)
    this._rel      = 0.9998; // Release (je näher an 1 = langsamer schließen)
    this._openThr  = 3.5;    // Öffnen  bei Signal/Floor > Wert
    this._closeThr = 1.5;    // Schließen wenn Signal/Floor < Wert
  }

  process(inputs, outputs) {
    const inp = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!inp || !out) return true;

    let sum = 0;
    for (let i = 0; i < inp.length; i++) sum += inp[i] * inp[i];
    const rms = Math.sqrt(sum / inp.length);

    // Noise Floor adaptiv tracken (nur wenn Gate geschlossen)
    if (!this._open) this._floor = this._floor * 0.999 + rms * 0.001;

    const ratio = rms / (this._floor + 0.001);
    if (ratio > this._openThr)  this._open = true;
    if (ratio < this._closeThr) this._open = false;

    for (let i = 0; i < inp.length; i++) {
      this._env = this._open
        ? 1 - (1 - this._env) * this._atk
        : this._env * this._rel;
      out[i] = inp[i] * this._env;
    }
    return true;
  }
}

registerProcessor('noise-gate', NoiseGateProcessor);