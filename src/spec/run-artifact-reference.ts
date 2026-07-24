export interface RunArtifactReference {
  readonly artifactId: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly bytes: number;
}
