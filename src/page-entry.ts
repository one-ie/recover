/**
 * page-entry.ts — the browser half of the SAME tool. It imports recover.ts and
 * nothing else, so the page and the CLI cannot drift into two answers.
 *
 * Bundled for file:// with:  bun run build:page
 * (bun build --target=browser; measured 279KB, 9ms, zero remote URLs in the
 * output — the bundle inlines @oneie/sdk and its noble/scure deps.)
 *
 * NOTHING LEAVES THE PAGE. No import from a CDN, no analytics, no beacon; the
 * words are read from a textarea into a local variable and never sent anywhere.
 * A balance read happens only when the holder types an endpoint and presses the
 * button, and the fetch is handed in explicitly rather than captured.
 */

import { addressesFromPhrase, fetchBalance, labelFor, recoverBoth, type AddressSet, type Chain } from './recover.ts'

const $ = (id: string) => document.getElementById(id) as HTMLElement

function render(sets: AddressSet[]): void {
  const out = $('out')
  out.textContent = ''
  for (const set of sets) {
    const block = document.createElement('section')
    const head = document.createElement('h2')
    // The label sits WITH the addresses it names — sending to the wrong set
    // loses the money, and a heading elsewhere on the page is not a label.
    head.textContent = labelFor(set.derivation)
    block.appendChild(head)
    for (const row of set.addresses) {
      const line = document.createElement('div')
      line.className = 'row'
      const chain = document.createElement('span')
      chain.className = 'chain'
      chain.textContent = row.chain
      const addr = document.createElement('code')
      addr.textContent = row.address
      line.append(chain, addr)
      block.appendChild(line)
    }
    out.appendChild(block)
  }
}

function fail(message: string): void {
  // The message never carries the phrase: it is the SDK's refusal text.
  $('out').textContent = ''
  $('err').textContent = message
}

async function recover(): Promise<void> {
  $('err').textContent = ''
  const phrase = ($('phrase') as HTMLTextAreaElement).value.trim()
  if (!phrase) return fail('Type your 24 words first.')
  const which = ($('derivation') as HTMLSelectElement).value
  try {
    if (which === 'both') {
      const both = await recoverBoth(phrase)
      render([both.v1, both.v2])
    } else {
      render([await addressesFromPhrase(phrase, which === 'v2' ? 'v2' : 'v1')])
    }
  } catch (e) {
    // No fallback. A phrase that does not check out derives nothing at all.
    fail(e instanceof Error ? e.message : String(e))
  }
}

async function balances(): Promise<void> {
  const rpc = ($('rpc') as HTMLInputElement).value.trim()
  const chain = ($('rpcChain') as HTMLSelectElement).value as Chain
  const target = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.chain')?.textContent === chain)
  const address = target?.querySelector('code')?.textContent ?? ''
  if (!rpc || !address) return fail('Recover first, then name an endpoint for that chain.')
  try {
    const out = await fetchBalance({ rpc, chain, address, fetchImpl: window.fetch.bind(window) })
    $('bal').textContent = `${chain} ${out.balance} (smallest unit, from ${rpc})`
  } catch (e) {
    $('bal').textContent = `unread — ${e instanceof Error ? e.message : String(e)}`
  }
}

$('go').addEventListener('click', () => void recover())
$('balgo').addEventListener('click', () => void balances())
