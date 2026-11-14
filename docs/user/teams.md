# Teams

A team lets the people you invite follow threads on your machine and, if you allow it, send messages
to the agent. They see only the threads you share, one at a time. Your other threads, projects,
files and terminals stay private.

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

In the team workspace, each shared machine lists the threads shared with that team, grouped by
project. A teammate sees the thread as it streams: messages, the agent's replies and its work.

- With **View**, there is no message box. They see "View only" and the name of the owner to ask.
- With **Steer**, they can send text messages. While the agent works, **Steer** sends the message
  into the current turn and **Queue** holds it for after the turn. They can also stop the agent.

Teammates cannot rename, delete, archive or settle the thread, change its model or mode, attach
files, answer the agent's questions, open terminals or files, or start threads on your machine.
They also cannot send slash commands such as `/compact`: a message that starts with `/` is refused.

A message from a teammate with **Steer** starts a turn in the thread's current permission mode. In a
full-access thread, that turn can run commands and change files on your machine without asking.
Give **Steer** on a full-access thread only to people you would let use your machine.

Each message shows who sent it. Avatars in the thread header and the sidebar show who has the thread
open, and a line above the message box shows who is typing.

## Stop sharing

- One thread: select the badge in the thread header, or use **Stop sharing thread** in the command
  palette. Teammates see that the thread is no longer shared.
- A whole machine: turn it off in **Settings → Team → Shared machines**. Teammates lose every thread
  on it.

## When access ends

Stopping a share, removing a member, changing a member's role or deleting the team ends access at
once on every machine of yours that this device can reach. A teammate who is removed or changes
role reconnects with their new access, or not at all.

Any other machine, for example one that is asleep, offline or owned by another teammate, does not
hear about the change. Teammates already connected to it keep access for up to 10 minutes, until their session
needs renewing and T3 Connect refuses it.

If one person is in two teams that share the same machine, they see only the threads of the team
that shared the machine first.

Anything the agent read or printed can show to the team, such as a value from a file. Share only
threads you are comfortable showing.
