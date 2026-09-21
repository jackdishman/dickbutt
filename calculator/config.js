const configKeys=['chainId','token','distributor','deployBlock','holderThresholdRaw','payoutThresholdRaw','curve','excluded','batchSize','chunkSize','finalityTag'];

/** Optional, hash-bound policy for new journals. Never inferred from an environment variable. */
export function readPruningPolicy(config) {
 const value=config.pruneSettledPlans;
 if (value!==undefined&&typeof value!=='boolean') throw Error('pruneSettledPlans must be a boolean');
 if (value===true&&config.finalityTag!=='finalized') throw Error('plan pruning requires finalized history');
 return value===true;
}

export function validateCalculatorConfigShape(config) {
 const expected=[...configKeys,...(Object.hasOwn(config,'pruneSettledPlans')?['pruneSettledPlans']:[])];
 const actual=Object.keys(config);
 if(actual.length!==expected.length||expected.some((key,index)=>actual[index]!==key)) throw Error(`config must contain exactly ${expected.join(', ')} in that order; the calculator hashes its serialization`);
 readPruningPolicy(config);
}

/** Round IDs and pruning cursors are canonical uint256 strings, never JS numbers. */
export function uint256String(value,name,{allowZero=true}={}) {
 if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)) throw Error(`invalid ${name}: expected a canonical uint256 string`);
 const n=BigInt(value);
 if(n>(1n<<256n)-1n||(!allowZero&&n===0n)) throw Error(`invalid ${name}: outside uint256 range`);
 return n;
}
