/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// Flight SERVER config for the ESM transport on an EDGE (Web-streams) server.
// Mirrors ReactFlightServerConfig.dom-edge (the generic edge server config) but
// swaps the WEBPACK bundler for the ESM bundler. This file MUST exist: without
// it the build's nearest-fork resolution falls back to dom-edge.js, which pulls
// react-server-dom-webpack's bundler into the ESM transport.

import type {Request} from 'react-server/src/ReactFlightServer';
import type {ReactComponentInfo} from 'shared/ReactTypes';

export * from 'react-server-dom-esm/src/server/ReactFlightServerConfigESMBundler';
export * from 'react-dom-bindings/src/server/ReactFlightServerConfigDOM';

// Edge runtimes may not expose AsyncLocalStorage; read it from the global scope
// and guard, exactly like ReactFlightServerConfig.dom-edge.
export const supportsRequestStorage: boolean =
  typeof AsyncLocalStorage === 'function';
export const requestStorage: AsyncLocalStorage<Request | void> =
  supportsRequestStorage ? new AsyncLocalStorage() : (null: any);

export const supportsComponentStorage: boolean =
  __DEV__ && supportsRequestStorage;
export const componentStorage: AsyncLocalStorage<ReactComponentInfo | void> =
  supportsComponentStorage ? new AsyncLocalStorage() : (null: any);

export * from '../ReactFlightServerConfigDebugNoop';

export * from '../ReactFlightStackConfigV8';
export * from '../ReactServerConsoleConfigServer';
