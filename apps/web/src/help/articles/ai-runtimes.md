---
title: AI runtimes and accounts
summary: Sign in to Claude Code, Codex and the Gemini CLI, set API keys, and give a project its own account.
keywords: [ai runtime, accounts, codex, gemini, claude, api key, openai, anthropic, bedrock, vertex, sign in, main account]
order: 28
---

**Integrations, AI runtime** shows what a workstation can run agents on: Claude Code, Codex, the Gemini CLI, opencode, and API providers (Anthropic, OpenAI, Gemini, any OpenAI-compatible endpoint, and Claude Code on Amazon Bedrock, Vertex AI or a gateway).

## Accounts {#accounts}

Each runtime and provider has one **main account** and any number of **named accounts**, per workstation. Use **Add a named account** and give it a short name such as `work`. The main account is what the CEO, DevOps and chats always use.

A tile shows whether the program is installed (with the command to install it), who is signed in, whether a key is set and whose key is in effect, and a **Runner too old** note when the workstation's runner needs an update. The runner looks for a program when it starts, so restart it after installing one.

## Sign in {#sign-in}

**Sign in** runs the program's own login on the workstation. Open the link, enter the code (Codex) or paste the code (Claude, Gemini), and the account shows **Signed in**. Each named account keeps its login in a folder of its own, so two accounts never mix. **Remove** deletes the login Guildwise stored for a named account.

## Keys {#keys}

**Set key** encrypts the key in your browser for that workstation's runner, which keeps it. This needs HTTPS or localhost. A named account is your own key, so it is not capped. Organization keys and their monthly caps stay under **Settings, Model providers**: a project can also choose the organization's key as its account, and the cap still applies.

## Sharing {#sharing}

A named account belongs to one workstation and spends its owner's own key or login. **Allow projects to use my accounts** (on the AI runtime section, off by default) lets projects you are not a member of pick your named accounts; with it off, only projects you are a member of may, and the others wait or use the main account. To let several workstations use one key, set the organization key under **Settings, Model providers**: it goes to the workstations you tick and its monthly cap applies.

## Make main {#make-main}

**Make main** swaps a named account with the main account. Nothing is lost, and doing it again undoes it.

## Per project {#projects}

In a project's settings, **Accounts for other providers** (and **Claude account**) choose which account the project's tickets use. If the account is out (usage limit, login or key), the tickets pause, or use the main account if you ticked the fallback box. A notice on your desk says which account needs attention.
