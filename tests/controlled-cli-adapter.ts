import { CliAdapter, type Discovery, type Model } from '../src/cli-adapter.js';

/** Returns a fresh deterministic discovery result for controlled test adapters without probing the host environment. */
export function fixtureDiscovery(): Discovery {
  return {
    installed: true,
    path: 'mock-agy',
    authenticated: true,
    capabilities: {
      structuredOutput: true,
      streaming: true,
      sandbox: true,
      readOnlyMode: true,
      models: true,
      modelSelection: true,
      resume: true,
      sessionsList: false,
      cancel: false,
    },
  };
}

/**
 * Base class for controlled CliAdapter test fixtures that overrides discovery
 * deterministically so simulated runs never probe ambient PATH or require a real agy binary.
 */
export class ControlledCliAdapter extends CliAdapter {
  private cachedDiscovery?: Discovery;

  override getDiscovery(): Discovery | undefined {
    return this.cachedDiscovery;
  }

  override async discover(): Promise<Discovery> {
    const discovery = fixtureDiscovery();
    this.cachedDiscovery = discovery;
    return discovery;
  }

  override async listModels(): Promise<Model[]> {
    return [];
  }
}
