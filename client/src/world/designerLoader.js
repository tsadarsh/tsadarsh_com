import SimplexNoise from 'simplex-noise';

// Seeded PRNG (mulberry32)
function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function parseHexColor(hex) {
  if (!hex) return [1,1,1];
  if (hex[0] === '#') hex = hex.slice(1);
  const r = parseInt(hex.slice(0,2),16)/255;
  const g = parseInt(hex.slice(2,4),16)/255;
  const b = parseInt(hex.slice(4,6),16)/255;
  return [r,g,b];
}

function lerp(a,b,t){ return a + (b-a) * t; }
function lerpColor(c1,c2,t){ return [ lerp(c1[0],c2[0],t), lerp(c1[1],c2[1],t), lerp(c1[2],c2[2],t) ]; }

export function createWorldFromDesign(design, seed) {
  // design: JSON following spec
  const terrain = design.terrain || {};
  const opts = {
    chunkSize: terrain.chunkSize || 32,
    spacing: terrain.spacing || 1.0,
    amplitude: typeof terrain.amplitude === 'number' ? terrain.amplitude : (terrain.amplitude || 3.5),
    baseHeight: typeof terrain.baseHeight === 'number' ? terrain.baseHeight : 0,
    noise: Object.assign({ type: 'simplex', octaves: 4, frequency: 0.006, lacunarity: 2.0, persistence: 0.5, seedOffset: 0 }, terrain.noise || {}),
    colorRamp: terrain.colorRamp || [ { elevation: -1, color: '#2a6f2a' }, { elevation: 1, color: '#8ad38a' } ],
    slopeTint: terrain.slopeTint || { enabled: true, steepColor: '#6b8b3c', factor: 1.0 },
    terraforms: terrain.terraforms || [],
    streamingHints: design.streamingHints || {}
  };

  // build color stops sorted
  const colorStops = (opts.colorRamp || []).slice().sort((a,b)=>a.elevation - b.elevation).map(s => ({e: s.elevation, c: parseHexColor(s.color)}));
  const steepColor = parseHexColor((opts.slopeTint && opts.slopeTint.steepColor) || '#6b8b3c');

  // seed combination
  const baseSeedNum = (typeof seed === 'number') ? seed : Number(String(seed).split('').reduce((a,c)=>a+c.charCodeAt(0),0));
  const noiseSeed = baseSeedNum + (opts.noise.seedOffset || 0);
  const rnd = mulberry32(noiseSeed);
  const simplex = new SimplexNoise(rnd);

  // fractal noise
  function fractalNoise2D(x, z) {
    let amp = 1.0;
    let freq = opts.noise.frequency || 0.006;
    let sum = 0.0;
    let max = 0.0;
    for (let o = 0; o < (opts.noise.octaves||4); o++) {
      sum += amp * simplex.noise2D(x * freq, z * freq);
      max += amp;
      amp *= opts.noise.persistence || 0.5;
      freq *= opts.noise.lacunarity || 2.0;
    }
    return sum / max; // approx in [-1,1]
  }

  // apply terraforms simple support (add/mul/pow/clamp)
  function applyTerraforms(h) {
    for (const t of opts.terraforms) {
      const val = (typeof t.value === 'number') ? t.value : 0;
      const r0 = (t.range && t.range[0]) || -Infinity;
      const r1 = (t.range && t.range[1]) || Infinity;
      if (h < r0 || h > r1) continue;
      switch(t.op) {
        case 'add': h = h + val; break;
        case 'mul': h = h * val; break;
        case 'pow': h = Math.sign(h) * Math.pow(Math.abs(h), val); break;
        case 'clamp': h = Math.max(r0, Math.min(r1, val)); break;
        case 'abs': h = Math.abs(h); break;
        default: break;
      }
    }
    return h;
  }

  function getHeightAt(wx, wz) {
    const n = fractalNoise2D(wx, wz);
    let h = n * opts.amplitude + opts.baseHeight;
    h = applyTerraforms(h);
    return h;
  }

  function getHeight(x,z){ return getHeightAt(x,z); }

  function getChunk(cx, cz) {
    const cells = opts.chunkSize;
    const vertsPerSide = cells + 1;
    const totalVerts = vertsPerSide * vertsPerSide;
    const positions = new Float32Array(totalVerts * 3);
    const colors = new Float32Array(totalVerts * 3);
    const indices = new Uint32Array(cells * cells * 6);

    const startX = cx * cells * opts.spacing;
    const startZ = cz * cells * opts.spacing;

    // precompute heights
    const heights = new Array(vertsPerSide);
    for (let iz=0; iz<vertsPerSide; iz++) {
      heights[iz] = new Float32Array(vertsPerSide);
      for (let ix=0; ix<vertsPerSide; ix++) {
        const wx = startX + ix * opts.spacing;
        const wz = startZ + iz * opts.spacing;
        heights[iz][ix] = getHeightAt(wx, wz);
      }
    }

    // fill positions/colors
    let vi = 0;
    for (let iz=0; iz<vertsPerSide; iz++) {
      for (let ix=0; ix<vertsPerSide; ix++) {
        const wx = startX + ix * opts.spacing;
        const wz = startZ + iz * opts.spacing;
        const h = heights[iz][ix];
        positions[vi*3+0] = wx;
        positions[vi*3+1] = h;
        positions[vi*3+2] = wz;

        // slope calc
        let dhdx=0, dhdz=0;
        if (ix>0 && ix<vertsPerSide-1) dhdx = (heights[iz][ix+1]-heights[iz][ix-1])/(2*opts.spacing);
        else if (ix>0) dhdx = (heights[iz][ix]-heights[iz][ix-1])/opts.spacing;
        else if (ix<vertsPerSide-1) dhdx = (heights[iz][ix+1]-heights[iz][ix])/opts.spacing;
        if (iz>0 && iz<vertsPerSide-1) dhdz = (heights[iz+1][ix]-heights[iz-1][ix])/(2*opts.spacing);
        else if (iz>0) dhdz = (heights[iz][ix]-heights[iz-1][ix])/opts.spacing;
        else if (iz<vertsPerSide-1) dhdz = (heights[iz+1][ix]-heights[iz][ix])/opts.spacing;
        const slope = Math.sqrt(dhdx*dhdx + dhdz*dhdz);

        // color ramp interpolation based on elevation
        let col = [0.6,0.6,0.6];
        if (colorStops && colorStops.length) {
          // find two stops
          if (colorStops.length === 1) col = colorStops[0].c;
          else {
            // normalize elevation w.r.t amplitude for mapping
            // but use raw elevation values from stops
            let lower = colorStops[0];
            let upper = colorStops[colorStops.length-1];
            for (let si=0; si<colorStops.length-1; si++) {
              if (h >= colorStops[si].e && h <= colorStops[si+1].e) { lower = colorStops[si]; upper = colorStops[si+1]; break; }
            }
            const denom = (upper.e - lower.e) || 1e-6;
            const t = (h - lower.e) / denom;
            col = lerpColor(lower.c, upper.c, Math.max(0, Math.min(1,t)));
          }
        }

        // slope tint
        if (opts.slopeTint && opts.slopeTint.enabled) {
          const slopeScale = opts.slopeTint.factor || 1.0;
          const slopeT = Math.max(0, Math.min(1, slope / (1.5/slopeScale)));
          col = lerpColor(col, steepColor, slopeT);
        }

        // small noise modulation to avoid flatness
        const n = simplex.noise2D(wx * 0.08, wz * 0.08) * 0.02;
        colors[vi*3+0] = Math.max(0, col[0] + n);
        colors[vi*3+1] = Math.max(0, col[1] + n);
        colors[vi*3+2] = Math.max(0, col[2] + n);

        vi++;
      }
    }

    // indices
    let ii=0;
    for (let iz=0; iz<cells; iz++) {
      for (let ix=0; ix<cells; ix++) {
        const a = iz*vertsPerSide + ix;
        const b = a + 1;
        const c = a + vertsPerSide;
        const d = c + 1;
        indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
        indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
      }
    }

    return { positions, colors, indices, vertsPerSide, spacing: opts.spacing };
  }

  function releaseChunk(cx, cz) { /* no-op */ }

  return { getChunk, releaseChunk, options: opts, getHeight };
}

export async function loadWorldDesign(path, seed) {
  try {
    const res = await fetch(path, {cache: 'no-store'});
    if (!res.ok) throw new Error('no design');
    const design = await res.json();
    return createWorldFromDesign(design, seed);
  } catch (e) {
    console.warn('loadWorldDesign failed', e);
    return null;
  }
}
