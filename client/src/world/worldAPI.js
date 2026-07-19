import SimplexNoise from 'simplex-noise';

// Simple seeded PRNG (mulberry32)
function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ t >>> 15, 1 | t);
    r = r + Math.imul(r ^ r >>> 7, 61 | r) ^ r;
    return ((r ^ r >>> 14) >>> 0) / 4294967296;
  };
}

export function createWorld(seed = 1, params = {}) {
  const opts = Object.assign({
    chunkSize: 32, // cells per chunk (so vertices = chunkSize+1)
    spacing: 1.0, // world units between vertices
    amplitude: 3.5, // max height
    baseFrequency: 0.0065,
    octaves: 4,
    persistence: 0.5
  }, params || {});

  const rnd = mulberry32(typeof seed === 'number' ? seed : (Number(String(seed).split('').reduce((a,c)=>a+c.charCodeAt(0),0))));
  const simplex = new SimplexNoise(rnd);

  function fractalNoise2D(x, y) {
    let amp = 1.0;
    let freq = opts.baseFrequency;
    let sum = 0.0;
    let max = 0.0;
    for (let o = 0; o < opts.octaves; o++) {
      sum += amp * simplex.noise2D(x * freq, y * freq);
      max += amp;
      amp *= opts.persistence;
      freq *= 2.0;
    }
    return sum / max; // normalized roughly to [-1,1]
  }

  function getHeightAt(x, z) {
    // x,z in world units
    const n = fractalNoise2D(x, z);
    // gentle shaping to make rolling hills
    const h = n * opts.amplitude;
    return h;
  }

  function getHeight(x, z) {
    // public alias for getHeightAt
    return getHeightAt(x, z);
  }

  function getChunk(cx, cz) {
    // chunk coordinates (integers). returns raw mesh data (positions, indices, colors) in world space
    const cells = opts.chunkSize;
    const vertsPerSide = cells + 1;
    const totalVerts = vertsPerSide * vertsPerSide;
    const positions = new Float32Array(totalVerts * 3);
    const colors = new Float32Array(totalVerts * 3);
    const indices = new Uint32Array(cells * cells * 6);

    const startX = cx * cells * opts.spacing;
    const startZ = cz * cells * opts.spacing;

    // first compute heights into a 2D array for slope computation
    const heights = new Array(vertsPerSide);
    for (let iz = 0; iz < vertsPerSide; iz++) {
      heights[iz] = new Float32Array(vertsPerSide);
      for (let ix = 0; ix < vertsPerSide; ix++) {
        const wx = startX + ix * opts.spacing;
        const wz = startZ + iz * opts.spacing;
        heights[iz][ix] = getHeightAt(wx, wz);
      }
    }

    // helper: color ramps
    function lerp(a, b, t) { return a + (b - a) * t; }
    function lerpColor(c1, c2, t) {
      return [ lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t) ];
    }

    // define color stops (low, mid, high)
    const lowCol = [0.07, 0.2, 0.05];    // dark green
    const midCol = [0.18, 0.7, 0.18];    // bright grass
    const highCol = [0.8, 0.8, 0.5];     // light (dry) peaks
    const rockCol = [0.45, 0.42, 0.38];  // rock tint for steep slopes

    // compute positions and colors using heights and slope
    let vi = 0;
    for (let iz = 0; iz < vertsPerSide; iz++) {
      for (let ix = 0; ix < vertsPerSide; ix++) {
        const wx = startX + ix * opts.spacing;
        const wz = startZ + iz * opts.spacing;
        const h = heights[iz][ix];
        positions[vi * 3 + 0] = wx;
        positions[vi * 3 + 1] = h;
        positions[vi * 3 + 2] = wz;

        // compute slope magnitude using central differences
        let dhdx = 0, dhdz = 0;
        if (ix > 0 && ix < vertsPerSide - 1) {
          dhdx = (heights[iz][ix+1] - heights[iz][ix-1]) / (2 * opts.spacing);
        } else if (ix > 0) {
          dhdx = (heights[iz][ix] - heights[iz][ix-1]) / opts.spacing;
        } else if (ix < vertsPerSide - 1) {
          dhdx = (heights[iz][ix+1] - heights[iz][ix]) / opts.spacing;
        }
        if (iz > 0 && iz < vertsPerSide - 1) {
          dhdz = (heights[iz+1][ix] - heights[iz-1][ix]) / (2 * opts.spacing);
        } else if (iz > 0) {
          dhdz = (heights[iz][ix] - heights[iz-1][ix]) / opts.spacing;
        } else if (iz < vertsPerSide - 1) {
          dhdz = (heights[iz+1][ix] - heights[iz][ix]) / opts.spacing;
        }
        const slope = Math.sqrt(dhdx * dhdx + dhdz * dhdz);

        // height-based t [0,1]
        const t = Math.max(0, Math.min(1, (h / opts.amplitude + 1) * 0.5));
        // ramp between low->mid->high
        let heightCol;
        if (t < 0.5) {
          heightCol = lerpColor(lowCol, midCol, t / 0.5);
        } else {
          heightCol = lerpColor(midCol, highCol, (t - 0.5) / 0.5);
        }

        // slope influence: higher slope -> more rockCol
        const slopeScale = 1.5; // adjust sensitivity
        const slopeT = Math.max(0, Math.min(1, slope / slopeScale));
        const finalCol = lerpColor(heightCol, rockCol, slopeT);

        // small noise modulation for variation
        const n = simplex.noise2D(wx * 0.08, wz * 0.08) * 0.02;
        colors[vi * 3 + 0] = Math.max(0, finalCol[0] + n);
        colors[vi * 3 + 1] = Math.max(0, finalCol[1] + n);
        colors[vi * 3 + 2] = Math.max(0, finalCol[2] + n);

        vi++;
      }
    }

    // indices
    let ii = 0;
    for (let iz = 0; iz < cells; iz++) {
      for (let ix = 0; ix < cells; ix++) {
        const a = iz * vertsPerSide + ix;
        const b = a + 1;
        const c = a + vertsPerSide;
        const d = c + 1;
        // tri: a, c, b
        indices[ii++] = a;
        indices[ii++] = c;
        indices[ii++] = b;
        // tri: b, c, d
        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = d;
      }
    }

    return {
      positions,
      colors,
      indices,
      vertsPerSide,
      spacing: opts.spacing
    };
  }

  function releaseChunk(cx, cz) {
    // no-op for now
  }

  return { getChunk, releaseChunk, options: opts, getHeight };
}
