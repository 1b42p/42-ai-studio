// Stop only the collector if its parent dies; the server keeps its durable turn.
if (process.channel) {
  process.on("disconnect", () => process.exit(2));
  process.channel.unref();
}
