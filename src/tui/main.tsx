/** Interactive TUI entry point (ink). Kept small: it renders the same core. */

import { render } from "ink"
import React from "react"
import { App } from "./App"

export interface TuiOptions {
  chain?: string
  signer?: string
}

export async function runTui(options: TuiOptions = {}) {
  const instance = render(
    React.createElement(App, { chain: options.chain, signer: options.signer }),
  )
  await instance.waitUntilExit()
}
