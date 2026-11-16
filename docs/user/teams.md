# Teams

A team lets the people you invite follow threads on your machine and, if you allow it, send messages
to the agent. They see only the threads you share, one at a time, and the threads in projects you
share with the team. Your other threads, projects, files and terminals stay private.

## Start a team

1. Sign in, then open the workspace switcher at the top of the sidebar and choose **Create team**.
2. Invite people from **Settings → Team**. They join with their own account.
3. Switch the sidebar between **Personal** and the team with the workspace switcher. Personal shows
   only your own machines and threads.

Sharing needs [T3 Connect](./remote-access.md) on the machine that runs the thread, and that
machine must run a recent T3 Code. An older machine shows **Update this machine to share with a
team**.

## Share a thread

1. Open the thread menu, or the command palette, and choose **Share with team…**.
2. Pick the team and the level:
   - **View**: teammates read along as the agent works.
   - **Steer**: teammates can also send messages and stop the agent.
3. Choose **Share**. If the machine is not shared with the team yet, this shares it too.

To share a machine before any thread, use **Settings → Team → Shared machines** or **Share this
machine with team…** in the command palette.

A shared thread shows a small badge in its header. Select it to change the level or stop sharing.

## What teammates see and can do

In the team workspace, the sidebar lists the team's projects first (see
[Team projects](#team-projects)), then the team's people: you first, then everyone else by name,
with their picture and whether their agent is ready. Under each person are the threads they shared
with the team and the questions asked of their agent, newest first. A teammate sees a thread as it
streams: messages, the agent's replies and its work.

- With **View**, there is no message box. They see "View only" and the name of the owner to ask.
- With **Steer**, they can send text messages. While the agent works, **Steer** sends the message
  into the current turn and **Queue** holds it for after the turn. They can also stop the agent.

Teammates cannot rename, delete, archive or settle the thread, change its model or mode, attach
files, answer the agent's questions, or open terminals or files. They can start threads on your
machine only in a project you shared with the team. They also cannot send slash commands such as
`/compact`: a message that starts with `/` is refused.

A message from a teammate with **Steer** starts a turn in the thread's current permission mode. In a
full-access thread, that turn can run commands and change files on your machine without asking.
Give **Steer** on a full-access thread only to people you would let use your machine.

Each message shows who sent it. Avatars in the thread header and the sidebar show who has the thread
open, and a line above the message box shows who is typing.

## Team projects

A team project is a project on your machine that the whole team works in. Every thread started in
it is shared with the team with **Steer**, whoever starts it, and anyone in the team can start a
thread in it. A fork or subagent of a thread keeps that thread's sharing, so a fork of a private
thread stays private, and a task delegated from another machine stays private too. The project stays on your machine; nothing is copied to other machines.

To start one, choose **Start a team project** in the team sidebar, the command palette or **Settings
→ Team → Team projects**. Pick one of your machines shared with the team, then a project on it or
**Add a project…**, then the model and access level that teammates' threads get, and choose **Share
with <team>**. You can also choose **Share with team** in a project's menu in the Personal sidebar.
A small team mark shows on a shared project there. **No project** holds your own agent's chat, so
it cannot be shared with a team.

- To start a thread, select the pen next to the project in the team sidebar, or **New thread in
  <project>** in the command palette. A teammate types the first message and sends it; the thread
  runs on your machine with the model and access you picked. They cannot change either.
- Teammates' threads get **Full access**: they run commands and change files on your machine without
  asking, because nobody can answer an approval for them. Share a project only with people you
  would let use your machine.
- Threads that were in the project before you shared it stay private. Share them one by one if you
  want to. You can still make one thread private with **Stop sharing** on its badge.

To change the model or access, use **Team sharing** in the project's menu or **Change** in **Settings
→ Team → Team projects**. To stop, choose **Stop sharing with team** or **Stop sharing** there. The
team loses the project and every thread in it that was shared with the team. Stopping sharing the
machine, or deleting the project, ends it too. A team project cannot be archived: stop sharing it
first.

## Ask a teammate's agent

Each person's agent answers questions about their work, from their own machine. It is useful when
you want to know how something was built or why, without waiting for the person.

To ask, select a person whose agent is ready in the team sidebar, or use **Ask <name>'s agent** in
the command palette. Type the question and press Enter. A new conversation opens and the answer
streams in. It is listed under that person for the whole team: anyone in the team can read it and
ask a follow-up. The person sees every question asked of their agent. A question cannot start
with `/` or name a file with `@` followed by `~`, `./`, `../` or a quote, such as `@./src/auth.ts`.
Write the path without `@` and the agent reads it. Package names such as `@types/node` are fine.

The agent only reads. It can read the code and the past threads of the projects its owner picked.
It never reads secret files such as `.env` files, keys, credentials or the `.git` folder, nor
T3 Code's own data, and it skips threads shared with another team. It cannot change files, run
commands that change anything, start threads or answer for its owner. It sees nothing from other
projects. An agent answers at most two questions at a time, follow-ups included.

A person's status in the sidebar says why you cannot ask: **Agent off**, **Offline**, **No machine
yet**, or **Needs an update** when their machine runs an older T3 Code or their Claude Code is older
than 2.1.248.

### Turn on your agent

Your agent is off until you turn it on. Open **Settings → Team → My agent**, or **My agent** in the
command palette. For each of your machines shared with the team, pick at least one project and a
Claude model, then turn on the switch. The setting is per machine and per team. The agent needs
Claude Code 2.1.248 or newer on that machine. Agent conversations are shared with the team, so
they run on the team's connection when it has one (see below).

The agent reads the past threads of the projects you pick, so a secret that was ever printed in one
of those threads can reach a teammate. Pick project folders, not a broad folder such as your home
folder or `/`: the agent can read every file there that is not on its secret list.

Turn the switch off and nobody can ask new questions or send follow-ups, and any answer still
running stops. Old conversations stay readable, and you can delete them like any thread. Agent
conversations show only in the team workspace, not in Personal. Stop sharing the machine with the
team and its agent setting for that team goes too.

## Whose accounts a shared thread uses

A shared thread runs on the owner's Claude and Codex accounts, whoever sends the message, unless the
team connects its own [CLIProxyAPI](./usage.md#connect-a-cliproxyapi-hub) hub.

To connect one, a team owner or admin opens **Settings → Team → Connectivity**, chooses **Connect**,
and enters the hub's address and one of its client access keys. The key goes to T3 Connect and no
screen shows it again. Members see the address and who set it. An admin can **Replace** or
**Remove** it.

Then every thread shared with the team that uses Claude or Codex runs through the team's hub with
the team's key, for the owner's and teammates' messages alike. The owner's own Claude settings and
environment do not change that: Bedrock, Vertex and other provider switches, an API key helper, and
custom headers are turned off for team threads. Other providers stay on the owner's accounts. Stop
sharing the thread and its next message is back on the owner's accounts.

- The share dialog and the header badge say what the thread runs on. Teammates see it under the
  message box.
- **Settings → Team → Connectivity** lists each of your machines shared with the team, with
  **Ready** or why it is not.
- The machine must run a recent T3 Code. An older one shows **Update this machine to use the team
  connection** and keeps using your accounts.
- A team with no key runs on your accounts: before an admin connects one, and after an admin
  removes it.
- After an admin connects a key, each machine fetches it within about 5 minutes. Until it does, team
  threads on that machine still run on your accounts.
- If the team has a key but the machine cannot get it, for example while T3 Connect is unreachable,
  messages in team threads fail until it is back. They do not fall back to your accounts.
- Claude's managed settings, the ones set for every user of the machine, cannot be turned off. If
  they choose another provider, address, key, key helper or headers, Claude messages in team threads
  fail instead of running on them.
- Commands the agent runs do not get the key, so asking the agent to print its environment does
  not show it. This protects the key from the agent's commands, not from someone who controls your
  machine: a teammate with **Steer** on a full-access thread can change files on it.
- A task the agent hands to another machine cannot use the team's hub, so the agent is told to run
  it on this machine instead.

## Stop sharing

- One thread: select the badge in the thread header, or use **Stop sharing thread** in the command
  palette. Teammates see that the thread is no longer shared.
- A whole machine: turn it off in **Settings → Team → Shared machines**. Teammates lose every thread
  on it.

## When access ends

Stopping a share, removing a member, changing a member's role or deleting the team ends access at
once on every machine of yours that this device can reach. A teammate who is removed or changes
role reconnects with their new access, or not at all.

A task a teammate started stops when their access to its thread ends, and their queued messages
are cancelled. Your own turns keep running, and you can continue a stopped thread by sending a
message.

Any other machine, for example one that is asleep, offline or owned by another teammate, does not
hear about the change. Teammates already connected to it keep access for up to 10 minutes, until their session
needs renewing and T3 Connect refuses it.

If one person is in two teams that share the same machine, they see only the threads of the team
that shared the machine first.

Anything the agent read or printed can show to the team, such as a value from a file. Share only
threads you are comfortable showing.
