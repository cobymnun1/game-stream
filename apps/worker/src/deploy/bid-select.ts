interface BidEntry {
  bid: {
    price: { amount: string; denom: string };
    bidId: {
      owner: string;
      dseq: number;
      gseq: number;
      oseq: number;
      provider: string;
    };
  };
}

export function selectCheapestAffordableBid(
  bids: BidEntry[],
  maxUaktPerBlock: number
): BidEntry["bid"] | null {
  const affordable = bids
    .filter((b) => Number(b.bid.price.amount) <= maxUaktPerBlock)
    .sort((a, b) => Number(a.bid.price.amount) - Number(b.bid.price.amount));

  return affordable[0]?.bid ?? null;
}
