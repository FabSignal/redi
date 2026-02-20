export interface VaultAssetStrategy {
  address: string;
  name: string;
  paused: boolean;
}

export interface VaultAsset {
  address: string;
  strategies: VaultAssetStrategy[];
}

export interface VaultRoles {
  "0": string;
  "1": string;
  "2": string;
  "3": string;
}

export interface DefindexVaultConfig {
  caller: string;
  roles: VaultRoles;
  vault_fee_bps: number;
  upgradable: boolean;
  name_symbol: {
    name: string;
    symbol: string;
  };
  assets: VaultAsset[];
}

export interface DefindexVaultInfo {
  name: string;
  symbol: string;
  assets: VaultAsset[];
  totalManagedFunds: { asset: string; total_amount: string }[];
}
