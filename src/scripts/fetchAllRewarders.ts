import { QuarrySDK } from "@quarryprotocol/quarry-sdk";
import type { Network } from "@saberhq/solana-contrib";
import type { TokenInfo, TokenList } from "@saberhq/token-utils";
import axios from "axios";
import * as fs from "fs/promises";
import { groupBy, keyBy, mapValues } from "lodash";

import { TOKEN_LIST_URLS } from "../constants";
import { makeProvider, stringify } from "../utils";

export const fetchAllRewarders = async (network: Network): Promise<void> => {
  const provider = makeProvider(network);
  const quarry = QuarrySDK.load({ provider });
  const allRewarders = await quarry.programs.Mine.account.rewarder.all();
  const allQuarries = await quarry.programs.Mine.account.quarry.all();
  const tokenLists = await Promise.all(
    TOKEN_LIST_URLS.map(async (url) => {
      try {
        const result = await axios.get<TokenList>(url);
        return result.data;
      } catch (e) {
        console.error(`Error fetching ${url}`, e);
        throw e;
      }
    })
  );

  const dir = `${__dirname}/../../data/${network}/`;
  await fs.mkdir(dir, { recursive: true });

  // addresses of each quarry
  const allQuarriesJSON = allQuarries.map((q) => ({
    rewarder: q.account.rewarderKey.toString(),
    quarry: q.publicKey.toString(),
    stakedToken: {
      mint: q.account.tokenMintKey.toString(),
      decimals: q.account.tokenMintDecimals,
    },
    cached: {
      index: q.account.index,
      famineTs: q.account.famineTs.toString(),
      lastUpdateTs: q.account.lastUpdateTs.toString(),
      rewardsPerTokenStored: q.account.rewardsPerTokenStored.toString(),
      rewardsShare: q.account.rewardsShare.toString(),
      numMiners: q.account.numMiners.toString(),
      totalTokensDeposited: q.account.totalTokensDeposited.toString(),
    },
  }));

  const allRewarderQuarries = mapValues(
    groupBy(allQuarriesJSON, (q) => q.rewarder),
    (v) => {
      return v
        .map(({ rewarder: _rewarder, ...rest }) => rest)
        .sort((a, b) => (a.cached.index < b.cached.index ? -1 : 1));
    }
  );

  const allRewardersList = allRewarders.map((rewarder) => {
    const quarries = allRewarderQuarries[rewarder.publicKey.toString()] ?? [];
    if (rewarder.account.numQuarries !== quarries.length) {
      console.warn(
        `Expected ${
          rewarder.account.numQuarries
        } quarries on rewarder ${rewarder.publicKey.toString()}; got ${
          quarries.length
        }`
      );
    }

    const rewardsTokenMint = rewarder.account.rewardsTokenMint.toString();
    let rewardsTokenInfo: TokenInfo | null = null;
    for (const list of tokenLists) {
      rewardsTokenInfo =
        list.tokens.find((t) => t.address === rewardsTokenMint) ?? null;
      if (rewardsTokenInfo) {
        break;
      }
    }
    if (!rewardsTokenInfo) {
      console.warn(
        `rewards token ${rewardsTokenMint} not found in any of the token lists`
      );
    }

    return {
      rewarder: rewarder.publicKey.toString(),
      authority: rewarder.account.authority.toString(),
      rewardsToken: {
        mint: rewardsTokenMint,
        decimals: rewardsTokenInfo?.decimals ?? -1,
      },
      mintWrapper: rewarder.account.mintWrapper.toString(),
      quarries,
    };
  });
  const allRewardersJSON = mapValues(
    keyBy(allRewardersList, (r) => r.rewarder),
    ({ rewarder: _rewarder, quarries, ...info }) => ({
      ...info,
      quarries: quarries.map(
        ({ cached: _cached, ...quarryInfo }) => quarryInfo
      ),
    })
  );

  // tmp-token-list
  await fs.writeFile(`.tmp.token-list.json`, stringify(tokenLists));

  // rewarders without the cached values
  await fs.writeFile(`${dir}/all-rewarders.json`, stringify(allRewardersJSON));

  // quarries with cached values -- go in their own files
  await fs.mkdir(`${dir}/rewarders`, { recursive: true });
  for (const [rewarderKey, rewarderInfo] of Object.entries(allRewardersJSON)) {
    await fs.mkdir(`${dir}/rewarders/${rewarderKey}`, { recursive: true });
    await fs.writeFile(
      `${dir}/rewarders/${rewarderKey}/meta.json`,
      stringify(rewarderInfo)
    );
  }

  console.log(
    `Fetched ${allQuarriesJSON.length} quarries across ${
      Object.keys(allRewarders).length
    } rewarders on ${network}.`
  );
};

Promise.all([
  fetchAllRewarders("mainnet-beta"),
  fetchAllRewarders("devnet"),
]).catch((err) => {
  console.error(err);
  process.exit(1);
});
