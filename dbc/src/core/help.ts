export const HELP = `Commands
  /connect <name>              connect and activate a configured database
  /use <name>                  switch between open connections
  /connections                 show configured and open connections
  /autocommit on|off           change mode for the active connection
  /commit | /rollback          finish the active transaction
  /tables [pattern]            list tables; * is a wildcard
  /describe <table>            show columns
  /refresh                     reload table and column metadata
  /template save <name> <sql>  save a positional SQL template
  /template list|show|delete   manage templates
  /history                     show statements from this session
  /clear                       clear the notebook
  /help                        show this help
  /exit                        close connections and exit

Run a template by name followed by arguments:
  prop com.sample.property1

Placeholders are textual: {1}, {2}, ... . Quote arguments containing spaces.
Tab accepts a suggestion; Up/Down selects one. Enter runs input.
Ctrl+C cancels a running query; Ctrl+D exits when idle.`;
