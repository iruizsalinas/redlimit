import * as chai from 'chai';
import { GLOBAL_EXPECT, JestChaiExpect, setState } from '@vitest/expect';
chai.use(JestChaiExpect);
export const expect = chai.expect;
globalThis[GLOBAL_EXPECT] = expect;
setState({ assertionCalls: 0, customTesters: [] }, expect);
