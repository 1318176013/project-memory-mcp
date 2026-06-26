export type EmbeddingInput = {
  text: string;
};

export type EmbeddingResult = {
  vector: number[];
  model: string;
  provider: string;
  dimensions: number;
};

export interface EmbeddingProvider {
  embed(input: EmbeddingInput): Promise<EmbeddingResult>;
  embedBatch(inputs: EmbeddingInput[]): Promise<EmbeddingResult[]>;
}
