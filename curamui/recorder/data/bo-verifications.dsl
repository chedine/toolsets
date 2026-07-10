# Verifications flow: page tabs, row expand/collapse, row menu -> Add Proof.
click section "HCR Cases and Outcomes"
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "bo" as First Name
click button "Search"
click link in "Search Results" at row 1
click link in "Current Cases" where Type = "Insurance Affordability"
select nav "Evidence"
select navitem "Verifications"
select pagetab "Verified"
select pagetab "Not Applicable"
select pagetab "Outstanding"
expand row where Items for Verification = "Income Type"
collapse row where Items for Verification = "Income Type"
click rowmenu "Add Proof" where Items for Verification = "Income Type"
click button "Cancel"
