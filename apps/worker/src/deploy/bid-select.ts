// SDK Bid shape: { id: BidID, price: DecCoin, state }
// (the field is `id`, not `bidId`; price is a decimal coin)
interface BidEntry {
  bid: {
    price: { amount: string; denom: string };
    id: {
      owner: string;
      dseq: number | string | bigint;
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
