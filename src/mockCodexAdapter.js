export class MockCodexAdapter {
  async run({ task, project, emit, requestApproval }) {
    emit('codex.message', {
      message: `Analyzing request for ${project.name}: ${task.prompt}`
    });

    await delay(20);
    emit('codex.message', {
      message: 'Inspecting workspace and identifying likely edit surface'
    });

    await delay(20);
    emit('codex.diff', {
      files: [
        {
          path: 'src/example.js',
          summary: 'Would update the relevant implementation in a real Codex adapter'
        }
      ]
    });

    await delay(20);
    emit('codex.command', {
      command: 'npm test',
      risk: 'low',
      outcome: 'auto_allowed'
    });

    await delay(20);
    emit('codex.test', {
      command: 'npm test',
      passed: true,
      summary: 'Mock test suite passed'
    });

    const approval = await requestApproval({
      command: 'deploy latest build to device',
      reason: 'Deployment changes a connected device and should be user-approved',
      risk: 'high'
    });

    emit('codex.approval_result', {
      approvalId: approval.id,
      decision: approval.decision
    });

    if (approval.decision !== 'approved') {
      emit('codex.message', {
        message: 'Deployment step skipped because approval was not granted'
      });
    }

    return {
      summary: 'Mock Codex task completed',
      changedFiles: ['src/example.js'],
      tests: [{ command: 'npm test', passed: true }]
    };
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
