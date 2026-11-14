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

Each message shows who sent it. Avatars in the thread header and the sidebar show who has the thread
open, and a line above the message box shows who is typing.

## Stop sharing

- One thread: select the badge in the thread header, or use **Stop sharing thread** in the command
  palette. Teammates see that the thread is no longer shared.
- A whole machine: turn it off in **Settings → Team → Shared machines**. Teammates lose every thread
  on it.

Anything the agent read or printed can show to the team, such as a value from a file. Share only
threads you are comfortable showing.
