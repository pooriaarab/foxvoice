# What the foxvoice add-on sends, and its AMO data declaration

The manifest declares `data_collection_permissions: { "required": ["none"] }`.
This page lists everything that the add-on in `extension/` sends out of the
add-on, and why no AMO data type applies to it today.

## The rule we apply

AMO's add-on policies, section 6, define data transmission:

> For the purposes of this policy, data transmission refers to any data that
> is collected, used, transferred, shared, or handled outside of the add-on or
> the local browser.

The page "Firefox built-in consent for data collection and transmission"
(https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
says:

> If your extension doesn't collect or transmit any data, you indicate that by
> specifying the `none` required permission in the manifest.

## What leaves the add-on

| What | To whom | When | AMO data type |
|---|---|---|---|
| Requests for the Whisper model files | huggingface.co | The first time the user speaks, once per profile | None. The requests name a public model and hold no audio and no text. |
| The user's recorded speech, as a WAV file | whisper-server on `127.0.0.1:8178` | Only when the user picks "whisper-server on this computer" in Settings | See below. |
| The transcript and a fixed instruction | The model server URL in Settings, on `127.0.0.1` | After each turn | See below. |
| The IP address of this computer | huggingface.co | As part of any network connection | None. Every network request shows it. |

The add-on can reach only `127.0.0.1` besides the model hub: its only host
permission is `http://127.0.0.1/*`. The reply goes through foxmind with
`only: ["browser", "local"]`, so a model server URL on another computer is
skipped and gets no request. Nothing goes to the authors. The add-on has no
analytics, no error reports and no server.

## Decision

The speech and the transcript go to a server process that the user runs on
the same computer. They do not leave the computer, so we treat them as local
handling, as foxmind's add-on does for the same kind of server, and declare
`"none"`. The listing says what goes where.

This is a judgement call: a server on 127.0.0.1 is outside the browser
process. If AMO review reads section 6 that way, declare the type that fits
spoken input (`personalCommunications`) under `optional`, and ask Firefox's
consent before the first send.

## When this changes

If the add-on adds a cloud speech or model provider (a key the user types),
the same change must declare the data types it sends, under `optional`, and
ask Firefox's consent before the first send.
