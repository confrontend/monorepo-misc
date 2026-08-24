type WorkflowStepProps = {
  number: number | string;
  title?: string;
};

export const WorkflowStep = ({ number, title }: WorkflowStepProps) => (
  <span className="copytrade-workflow-step" title={title}>
    {number}
  </span>
);
