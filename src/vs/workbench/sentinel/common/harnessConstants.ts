/*---------------------------------------------------------------------------------------------
 *  ADR Schema 内嵌副本（与 resources/adr.schema.json 保持语义一致）
 *--------------------------------------------------------------------------------------------*/

export const ADR_SCHEMA_JSON = `{
	"$schema": "http://json-schema.org/draft-07/schema#",
	"title": "Architecture Decision Record",
	"type": "object",
	"required": ["logic_path", "dependency_whitelist_check", "potential_risks", "rollback_plan"],
	"properties": {
		"logic_path": { "type": "string", "minLength": 4 },
		"dependency_whitelist_check": { "type": "string", "minLength": 2 },
		"potential_risks": { "type": "string", "minLength": 2 },
		"rollback_plan": { "type": "string", "minLength": 2 }
	}
}`;
