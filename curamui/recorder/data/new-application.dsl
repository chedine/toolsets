# New Application from a person tab (first 4 IEG wizard pages, then exit).
param firstName = "Zeph"
param person = "Zeph Qarlson"
# must be on/before the SERVER clock (simulated date resets on app restart)
param appDate = "1/1/2026"
click section "HCR Cases and Outcomes"
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "${firstName}" as First Name
click button "Search"
click link "${person} - *" in "Search Results"
click tabmenu "New Application"
# page 1: Application Filing Date — set explicitly: the prefill is the server
# date at first entry and goes stale (future) across app restarts
enter "${appDate}" as Application Date
click button "Next"
# page 2: rights & responsibilities agreement
check "I agree*"
click button "Next"
# page 3: About You (section intro)
click button "Next"
# page 4: Information About You (person data prefilled; fill the mandatory rest)
select "Never Married" for Marital Status
select "Yes" for Do you live in Minnesota?
select "Yes" for Do you plan to make Minnesota your home?
select "Mail" for Preferred Contact Method
select "No" for Did you move to Minnesota in the last three months?
select "No" for Are you temporarily absent from Minnesota?
# revealed by the temporarily-absent answer (IEG conditional question)
select "No" for Are you homeless?
select "Mail" for How would you prefer to receive notices?
select "No" for Do you want us to send you a form to name someone as your authorized representative?
select "No" for Do you want us to send you a voter registration card?
select "Hennepin" for County
select "Yes" for Is the mailing address the same as your home address?
click button "Next"
# page 5 "More About You": Save & Exit validates the current page, so answer
# its two mandatory questions before parking the application
select "Yes" for Are you a US Citizen?
select "Yes" for Do you have a Social Security Number?
click button "Save & Exit"
