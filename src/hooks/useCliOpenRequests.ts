import { useEffect } from 'react'

import { planCliOpen } from '../lib/cliOpen'
import { useT } from '../lib/i18n'
import { cliTakePendingOpen, listenCliOpenPath } from '../lib/tauri'
import { AGENT_TYPE_LABELS, ALL_AGENT_TYPES } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

   
                                                                            
                                                        
  
                            
                                                                        
                                                 
   


export function useCliOpenRequests(hydrated: boolean) {
  const t = useT()

  useEffect(() => {
                                                                            
                                                                      
    if (!hydrated) return
    let disposed = false

    const openFromCli = (path: string) => {
      const store = useProjectsStore.getState()
      const plan = planCliOpen(path, store.projects)
      if (!plan) return

      if (plan.kind === 'existing') {
        store.openProjectWorkspace(plan.projectId)
        return
      }

      const project = store.createProject({ name: plan.name, defaultCwd: plan.cwd })
      const agent =
        ALL_AGENT_TYPES.find((candidate) => store.preferences.enabledAgents[candidate]) ?? 'shell'
      const terminal = store.createTerminal(project.id, {
        name: AGENT_TYPE_LABELS[agent],
        cwd: plan.cwd,
        firstTab: { type: agent, cwd: plan.cwd, runtimeProfile: 'lean' },
      })
      store.openTerminalWorkspace(project.id, terminal.id)
      useUiStore.getState().pushToast({ title: t('notif.cliProjectCreated'), body: plan.name })
    }

                                                                               
                                                   
    void cliTakePendingOpen()
      .then((path) => {
        if (!disposed && path) openFromCli(path)
      })
      .catch(() => {
                                                    
      })

    const unlisten = listenCliOpenPath((path) => {
      if (!disposed) openFromCli(path)
    })

    return () => {
      disposed = true
      void unlisten.then((stop) => stop())
    }
  }, [hydrated, t])
}
