# Files in question answers

When an agent asks a question that accepts a custom answer, use **Attach files** or paste an image into the answer field. On mobile, use the attachment button to choose photos or files. You can send a file by itself, with a selected option, or with a typed answer.

Each question keeps its own attachments as you move between questions. Your normal prompt draft stays separate. Wait for uploads to finish before submitting; retry or remove any failed upload. A failed response keeps the draft available to try again.

Files upload to the environment running the thread, including remote environments. The agent receives paths to those saved files with your answer and can open them with its available tools. Questions that only accept predefined choices do not offer attachments. Older servers need updating before this option appears.

Submitted attachments remain in the thread history. Reverting a thread removes attachments belonging to discarded answers; deleting the thread uses the same file cleanup as other attachments. You can attach up to 100 files across one set of answers, using the same file and total image size limits as the normal composer.

## Answer for me

When an agent asks a question and marks one option as recommended, T3 Code sends that option for you if nobody answers in time, and writes a "Decided for you" note in the thread. Approvals, questions without a recommended option for every part, and questions in archived threads are left alone.

The wait is 10 minutes by default. Change it or turn it off in **Settings → General → Notifications → Answer for me**. The setting belongs to the environment, so it also applies when you connect from another device. Agents cannot change it.
