In Claude:
1. Run the prompt from the agent-compress-prompt.md, with script.md attached. But
2. In a new chat with both the original and compressed documents:
Evaluate the compressed document for any omissions and add them. Do not forget the primary objective - keep documentation concise, nothing important shall be missing, but the documentation shall be as compressed and minimal as possible.
3. In a new chat with the latest compressed document:
Analyze the compressed Cascada Script documentation and identify ALL redundancies that can be removed while preserving 100% of unique behavioral information, without information loss. Create a prompt for an AI agent with the exact instructions detailing how to remove the specific redundancies that you have identified.
4. In a new chat with the lates compressed document, run the above generated prompt.