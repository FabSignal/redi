export interface CrossmintWallet {
  walletId: string;
  address: string;
  chain: string;
}

export interface CrossmintSignedTransaction {
  signedTransactionXDR: string;
  transactionHash: string;
}
