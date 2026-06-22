/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// Flight CLIENT config for the ESM transport on an EDGE (Web-streams) server.
// Mirrors the ESM client forks but with the Web stream config + the server
// target + usedWithSSR (an edge server, like dom-edge-webpack), keeping the ESM
// bundler/target — runtime reference resolution is closed by
// react-server-loader's reference gate, not the transport's open import.
//
// VERSION NOTE: this is shaped for the React STABLE train (19.2.x). It imports
// NO ReactClientDebugConfig — those modules (…ConfigNode/…ConfigPlain) only
// exist on the experimental train (19.3+). Adding one here makes the edge
// bundle fail to resolve on 19.2.x and aborts the whole react-server-dom-esm
// build. If this patch is ever built against experimental React, add the
// matching debug-config export (Node→Plain for an edge target).

export {default as rendererVersion} from 'shared/ReactVersion';
export const rendererPackageName = 'react-server-dom-esm';

export * from 'react-client/src/ReactFlightClientStreamConfigWeb';
export * from 'react-client/src/ReactClientConsoleConfigServer';
export * from 'react-server-dom-esm/src/client/ReactFlightClientConfigBundlerESM';
export * from 'react-server-dom-esm/src/client/ReactFlightClientConfigTargetESMServer';
export * from 'react-dom-bindings/src/shared/ReactFlightClientConfigDOM';
export const usedWithSSR = true;
