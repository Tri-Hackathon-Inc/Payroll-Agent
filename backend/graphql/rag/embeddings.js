// Local sentence embeddings: payroll documents do not leave the backend for indexing.
let extractorPromise;
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = 384;

class LocalEmbeddings {
  constructor() { this.dimensions = DIMENSIONS; this.version = `${MODEL}:q8:mean:v1`; }

  async embed(texts) {
    if (!texts.length) return [];
    if (!extractorPromise) {
      extractorPromise = import('@huggingface/transformers').then(async ({ pipeline, env }) => {
        env.cacheDir = process.env.EMBEDDING_CACHE_DIR || '/models';
        return pipeline('feature-extraction', MODEL, { dtype: 'q8', device: 'cpu',
          session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
      }).catch(error => { extractorPromise = null; throw error; });
    }
    const extractor = await extractorPromise;
    const vectors = [];
    for (let i = 0; i < texts.length; i += 8) {
      const output = await extractor(texts.slice(i, i + 8), { pooling: 'mean', normalize: true });
      vectors.push(...output.tolist());
    }
    return vectors;
  }
}

module.exports = { LocalEmbeddings };
