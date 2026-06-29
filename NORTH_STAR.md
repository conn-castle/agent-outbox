# North Star

Agent Outbox is for technical and non-technical agent users who want a better
way to answer agent questions and requests asynchronously. The human is the sole
user of the UI, so the product stays simple, calm, and focused on fast review.
The agent is the primary user of the API and CLI, so every interface is framed
around helping agents ask clearly, wait safely, and resume work without forcing
human developers to manage the queue by hand.

This is not a storage platform, a durable database for apps, or a general
workflow engine. It is a queue for async human interaction: the agent's outbox.
When there is ambiguity, choose the simplest design that helps an agent submit a
clear request, lets a human answer it with minimal friction, and gives the agent
an unambiguous result to act on. That same simplicity is why Agent Outbox
generally allows flexible content in inputs and outputs while keeping the schema
itself small and strict: the queue accepts what agents need to send, and the
product model stays simple enough to reason about, operate, and evolve.
