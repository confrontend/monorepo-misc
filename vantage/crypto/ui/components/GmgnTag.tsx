import type { ReactNode } from 'react';

export type GmgnTagTone = 'positive' | 'negative' | 'neutral';
export type GmgnTagInfo = { tone: GmgnTagTone; text: string };

export const GMGN_TAG_EXPLANATIONS: Record<string, GmgnTagInfo> = {
  smart_degen: {
    tone: 'positive',
    text: 'GMGN sees historically strong trading. Confirm with 30-day PnL, copy results, and risk checks.',
  },
  pump_smart: {
    tone: 'positive',
    text: 'Strong around early or new-token trading. Early entries may still be difficult to copy after delay.',
  },
  renowned: {
    tone: 'neutral',
    text: 'Known or notable wallet, such as an influencer, fund, or public figure. Reputation is not proof of profit.',
  },
  kol: {
    tone: 'neutral',
    text: 'KOL or influencer wallet. Public influence does not necessarily mean good copy-trading results.',
  },
  fresh_wallet: {
    tone: 'neutral',
    text: 'New wallet with little history. There is not enough track record to judge consistency safely.',
  },
  wash_trader: {
    tone: 'negative',
    text: 'Suspected fake or self-repeating trading used to create volume. Treat reported performance cautiously.',
  },
  fomo: {
    tone: 'negative',
    text: 'Often buys after a price move. A copy trader may enter even later and get worse execution.',
  },
  sniper: {
    tone: 'neutral',
    text: 'Buys extremely early at launch, often with automation. The strategy may be profitable but hard to copy.',
  },
  rat_trader: {
    tone: 'negative',
    text: 'Suspected insider or connected trader with unusually early information. Copiers may receive the trade too late.',
  },
  bundler: {
    tone: 'negative',
    text: 'Involved in bundled launch transactions or bot buying. Launch-time execution may not be reproducible by a copier.',
  },
  whale: {
    tone: 'neutral',
    text: 'Holds or trades a large amount. Size can affect liquidity and does not guarantee skill.',
  },
  top_holder: {
    tone: 'neutral',
    text: 'One of a token’s largest holders. Concentration and exit risk should be checked separately.',
  },
  transfer_in: {
    tone: 'neutral',
    text: 'Tokens entered by transfer, not necessarily a purchase. This can distort buy-based PnL and trade counts.',
  },
  dev_team: {
    tone: 'negative',
    text: 'Associated with a token development team. Own-token activity can create conflicts for copy-traders.',
  },
  creator: {
    tone: 'negative',
    text: 'Token creator or deployer. Selling into followers or launch liquidity can make copying unsafe.',
  },
  dev: {
    tone: 'negative',
    text: 'Developer or creator classification. Treat own-token activity as a possible conflict of interest.',
  },
  dex_bot: {
    tone: 'neutral',
    text: 'Automated trading bot linked to platforms such as Axiom, Photon, BullX, Trojan, or GMGN. Copyability depends on latency and execution.',
  },
  axiom: { tone: 'neutral', text: 'Axiom is a Solana trading terminal and execution platform.' },
  padre: {
    tone: 'neutral',
    text: 'Padre is a Solana trading terminal and token-trading platform.',
  },
  photon: {
    tone: 'neutral',
    text: 'Photon is a Solana trading terminal commonly used for fast token execution.',
  },
  gmgn: {
    tone: 'neutral',
    text: 'GMGN is the wallet analytics and trading platform that supplied this label.',
  },
  bullx: {
    tone: 'neutral',
    text: 'BullX is a multi-chain trading terminal and execution platform.',
  },
  trojan: { tone: 'neutral', text: 'Trojan is a Solana trading bot and execution platform.' },
  bluechip_owner: {
    tone: 'neutral',
    text: 'Also holds established or higher-quality tokens. This is background context, not proof of trading skill.',
  },
  arbitrager: {
    tone: 'positive',
    text: 'GMGN identifies arbitrage activity. Returns may depend on speed and may be difficult to reproduce.',
  },
  top_followed: {
    tone: 'positive',
    text: 'Among GMGN’s most-followed wallets. Popularity does not replace the delayed-copy test.',
  },
  top_renamed: {
    tone: 'positive',
    text: 'Among GMGN’s most-renamed or recognized wallets. Recognition is not proof of future performance.',
  },
  launchpad_smart: {
    tone: 'positive',
    text: 'Active around launchpads. Check holding time and delay impact before copying.',
  },
};

export const gmgnTagInfo = (tag: string): GmgnTagInfo =>
  GMGN_TAG_EXPLANATIONS[tag] ?? {
    tone: 'neutral',
    text: `GMGN label: ${tag.replaceAll('_', ' ')}.`,
  };

export const GmgnTag = ({ tag }: { tag: string }): ReactNode => {
  const info = gmgnTagInfo(tag);
  return (
    <span className={`copytrade-tag ${info.tone}`} title={info.text}>
      {tag.replaceAll('_', ' ')}
    </span>
  );
};
