import {args,required,inspect,writeReport,run} from './core.mjs';
run(()=>{
  const a=args(['items-root','modules-root','output-root']); required(a,'items-root','modules-root','output-root');
  const report=inspect(a['items-root'],a['modules-root']);
  writeReport(a['output-root'],'inspection.json',report,[a['items-root'],a['modules-root']]);
  if(!report.valid) process.exitCode=2;
});
