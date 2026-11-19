import { LinearClient } from "@linear/sdk";

/**
 * Linear, reduced to the five things the agent needs. Workflow states are
 * picked by type (started, completed) so it works with any team's naming.
 */
export function linear({ apiKey, teamId }) {
  const client = new LinearClient({ apiKey });
  let states;
  async function stateId(type, prefer) {
    if (!states) {
      const team = await client.team(teamId);
      states = (await team.states()).nodes;
    }
    const ofType = states.filter((s) => s.type === type).sort((a, b) => a.position - b.position);
    const named = prefer && ofType.find((s) => s.name.toLowerCase() === prefer);
    return (named || ofType[0])?.id;
  }
  return {
    async createIssue({ title, description }) {
      const payload = await client.createIssue({ teamId, title, description });
      const issue = await payload.issue;
      return { id: issue.id, key: issue.identifier, url: issue.url };
    },
    async moveTo(issueId, step) {
      const target = { start: ["started", "in progress"], review: ["started", "in review"], done: ["completed", "done"] }[step];
      const id = await stateId(target[0], target[1]);
      if (id) await client.updateIssue(issueId, { stateId: id });
    },
    async comment(issueId, body) {
      await client.createComment({ issueId, body });
    },
  };
}

/** In-memory Linear for tests and the offline demo. */
export function memoryLinear(prefix = "ENG") {
  const issues = [];
  return {
    issues,
    async createIssue({ title, description }) {
      const n = issues.length + 101;
      const issue = { id: `issue_${n}`, key: `${prefix}-${n}`, url: `https://linear.app/demo/issue/${prefix}-${n}`, title, description, state: "Todo", comments: [] };
      issues.push(issue);
      return { id: issue.id, key: issue.key, url: issue.url };
    },
    async moveTo(issueId, step) {
      issues.find((i) => i.id === issueId).state = { start: "In Progress", review: "In Review", done: "Done" }[step];
    },
    async comment(issueId, body) {
      issues.find((i) => i.id === issueId).comments.push(body);
    },
  };
}
