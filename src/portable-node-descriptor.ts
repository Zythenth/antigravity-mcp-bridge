export interface PortableNodeAssetDescriptor {
  fileName: 'node.exe' | 'LICENSE' | 'build.json';
  url: string;
  bytes: number;
  sha256: string;
}

interface PortableNodeDescriptorBase {
  buildId: 'node-v24.21.0-lpac1-win-x64';
  releaseTag: 'runtime-node-v24.21.0-lpac1-win-x64';
  releaseRepository: 'https://github.com/Zythenth/antigravity-mcp-bridge';
  platform: 'win32';
  arch: 'x64';
  nodeVersion: '24.21.0';
  moduleAbi: 137;
  libuvVersion: '1.52.1';
  libuvPatch: 'f46e4246b5277fe1c5888b88b24d8b78020dd4f8';
  source: {
    repository: 'https://github.com/nodejs/node';
    ref: 'v24.21.0';
    libuvPatch: 'f46e4246b5277fe1c5888b88b24d8b78020dd4f8';
  };
}

export interface AvailablePortableNodeDescriptor extends PortableNodeDescriptorBase {
  available: true;
  assets: {
    node: PortableNodeAssetDescriptor;
    license: PortableNodeAssetDescriptor;
    buildMetadata: PortableNodeAssetDescriptor;
  };
}

export interface UnavailablePortableNodeDescriptor extends PortableNodeDescriptorBase {
  available: false;
  unavailableReason: string;
}

export type PortableNodeDescriptor = AvailablePortableNodeDescriptor | UnavailablePortableNodeDescriptor;

/**
 * This module is the trust root for the portable runtime. CI supplies the release
 * coordinates only after it has built and verified the source-derived artifact.
 */
export const portableNodeDescriptor: PortableNodeDescriptor = {
  available: true,
  buildId: 'node-v24.21.0-lpac1-win-x64',
  releaseTag: 'runtime-node-v24.21.0-lpac1-win-x64',
  releaseRepository: 'https://github.com/Zythenth/antigravity-mcp-bridge',
  platform: 'win32',
  arch: 'x64',
  nodeVersion: '24.21.0',
  moduleAbi: 137,
  libuvVersion: '1.52.1',
  libuvPatch: 'f46e4246b5277fe1c5888b88b24d8b78020dd4f8',
  source: {
    repository: 'https://github.com/nodejs/node',
    ref: 'v24.21.0',
    libuvPatch: 'f46e4246b5277fe1c5888b88b24d8b78020dd4f8',
  },
  assets: {
    node: {
      fileName: 'node.exe',
      url: 'https://github.com/Zythenth/antigravity-mcp-bridge/releases/download/runtime-node-v24.21.0-lpac1-win-x64/node.exe',
      bytes: 104059392,
      sha256: '17a57ea14327d66e4c873866c29b3d87adce9321b9868b071d73c938458390e8',
    },
    license: {
      fileName: 'LICENSE',
      url: 'https://github.com/Zythenth/antigravity-mcp-bridge/releases/download/runtime-node-v24.21.0-lpac1-win-x64/LICENSE',
      bytes: 157609,
      sha256: '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace',
    },
    buildMetadata: {
      fileName: 'build.json',
      url: 'https://github.com/Zythenth/antigravity-mcp-bridge/releases/download/runtime-node-v24.21.0-lpac1-win-x64/build.json',
      bytes: 1682,
      sha256: 'bec7b3c590076895c074c4a085ea9d6aea7dec1cecb19518e7eb968eaf522d7e',
    },
  },
};
